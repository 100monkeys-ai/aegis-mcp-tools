import type { ZaruUser } from "../middleware/auth.js";

type FetchLike = typeof fetch;

export interface ZaruMemoryRecord {
  content: string;
  version: number;
  updated_at: string;
}

export interface ZaruClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function resolveUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Thrown when `setMemory` collides with a newer server-side version. The
 * caller (a tool handler in `streamable-http.ts`) re-surfaces the carried
 * `current` record to the LLM so it can re-read, merge, and retry.
 */
export class VersionConflictError extends Error {
  readonly current: ZaruMemoryRecord;
  constructor(current: ZaruMemoryRecord, message?: string) {
    super(
      message ??
        `zaru.memory.set version conflict: server is at version ${current.version}`,
    );
    this.name = "VersionConflictError";
    this.current = current;
  }
}

/**
 * The body of Zaru Web's `POST /api/chat/turn` (Zaru ADR-0049 D2). Only the
 * fields given are sent; Zaru Web validates them and refuses what it does
 * not take.
 */
export interface ZaruChatRequest {
  message: unknown;
  conversationId?: unknown;
  mode?: unknown;
}

/** A coded refusal, D1's `{ error, message }`, as Zaru Web answered it. */
export interface ZaruChatRefusal {
  error: string;
  message: string;
  [field: string]: unknown;
}

/**
 * Zaru Web's answer to one turn: D1's output object on a 2xx, or the coded
 * refusal it answered with its HTTP status.
 */
export type ZaruChatAnswer =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; status: number; refusal: ZaruChatRefusal };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * HTTP client for the zaru-client `/api/zaru-memory` REST surface (ADR-118)
 * and its turn route `/api/chat/turn` (Zaru ADR-0049).
 *
 * Mirrors the auth-forwarding pattern used by `OrchestratorClient` —
 * each call propagates the consumer user's own Bearer token (Keycloak JWT
 * or `aegis_*` API key) so the zaru-client session middleware identifies
 * the correct user. Memory is always keyed by `userId`.
 */
export class ZaruClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: ZaruClientOptions = {}) {
    const url =
      options.baseUrl ?? process.env.ZARU_CLIENT_URL ?? "http://localhost:3000";
    this.baseUrl = normalizeBaseUrl(url);
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async getMemory(user: ZaruUser): Promise<ZaruMemoryRecord> {
    const response = await this.fetchImpl(
      resolveUrl(this.baseUrl, "/api/zaru-memory"),
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${user.token}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `zaru-client getMemory failed: ${response.status} ${await response.text()}`,
      );
    }

    return (await response.json()) as ZaruMemoryRecord;
  }

  async setMemory(
    user: ZaruUser,
    content: string,
    version: number,
  ): Promise<ZaruMemoryRecord> {
    const response = await this.fetchImpl(
      resolveUrl(this.baseUrl, "/api/zaru-memory"),
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify({ content, version }),
      },
    );

    if (response.status === 409) {
      // Optimistic-concurrency conflict. The server returns its current
      // record so the LLM can re-read and merge before retrying.
      const body = (await response.json()) as
        | { current?: ZaruMemoryRecord }
        | ZaruMemoryRecord;
      const current =
        "current" in body && body.current
          ? body.current
          : (body as ZaruMemoryRecord);
      throw new VersionConflictError(current);
    }

    if (!response.ok) {
      throw new Error(
        `zaru-client setMemory failed: ${response.status} ${await response.text()}`,
      );
    }

    return (await response.json()) as ZaruMemoryRecord;
  }

  /**
   * Run one turn of the companion in Zaru Web (Zaru ADR-0049 D2):
   * `POST /api/chat/turn` with the caller's own token, as the memory calls
   * make theirs. A 2xx answer is D1's output object. Any other status is a
   * refusal: its `{ error, message }` body as Zaru Web sent it, or, when the
   * body carries no code, `unauthorized` for a 401 and `turn_failed`
   * otherwise. A failed fetch (Zaru Web unreachable) and a 2xx body that is
   * not a JSON object throw.
   */
  async chat(user: ZaruUser, request: ZaruChatRequest): Promise<ZaruChatAnswer> {
    const body: Record<string, unknown> = { message: request.message };
    if (request.conversationId !== undefined) {
      body.conversationId = request.conversationId;
    }
    if (request.mode !== undefined) body.mode = request.mode;

    const response = await this.fetchImpl(
      resolveUrl(this.baseUrl, "/api/chat/turn"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify(body),
      },
    );

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }

    if (response.ok) {
      if (!isRecord(parsed)) {
        throw new Error(
          `zaru-client chat answered ${response.status} without a JSON object`,
        );
      }
      return { ok: true, output: parsed };
    }

    if (isRecord(parsed) && typeof parsed.error === "string") {
      return {
        ok: false,
        status: response.status,
        refusal: {
          ...parsed,
          error: parsed.error,
          message:
            typeof parsed.message === "string"
              ? parsed.message
              : `Zaru Web answered ${response.status}`,
        },
      };
    }
    return {
      ok: false,
      status: response.status,
      refusal: {
        error: response.status === 401 ? "unauthorized" : "turn_failed",
        message: `Zaru Web answered ${response.status}: ${text.slice(0, 500)}`,
      },
    };
  }
}
