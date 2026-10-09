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

/** C1's refusal sentences for the conversation reads, where Zaru Web sent no code. */
export const CONVERSATION_REFUSAL_MESSAGES = {
  unauthorized: "Sign in, or use a valid API key, to read your conversations.",
  conversation_not_found: "There is no conversation of yours with that id.",
  unavailable:
    "Your conversations can't be read right now. Please try again in a moment.",
} as const;

/**
 * Zaru Web's answer to one conversation read (Zaru ADR-0059 C1, C3): C1's
 * output object on a 2xx, or the coded refusal it answered with its status.
 */
export type ZaruConversationsAnswer =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; status: number; refusal: ZaruChatRefusal };

/** `GET /api/zaru-conversations/`: `current` only when the request named one. */
export interface ZaruConversationsListRequest {
  limit?: number;
  current?: string;
}

/** `GET /api/zaru-conversations/<id>`. */
export interface ZaruConversationReadRequest {
  conversationId: string;
  cursor?: string;
  pageSize?: number;
  current?: string;
}

/** `GET /api/zaru-conversations/search`. */
export interface ZaruConversationsSearchRequest {
  query: string;
  limit?: number;
  current?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * HTTP client for the zaru-client `/api/zaru-memory` REST surface (ADR-118),
 * its turn route `/api/chat/turn` (Zaru ADR-0049) and its read-only
 * conversation routes under `/api/zaru-conversations/` (Zaru ADR-0059).
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

  /**
   * The person's own conversations, newest first (Zaru ADR-0059 C1, C3):
   * `GET /api/zaru-conversations/` with the caller's own token, as the memory
   * calls make theirs (C2).
   */
  async listConversations(
    user: ZaruUser,
    request: ZaruConversationsListRequest,
  ): Promise<ZaruConversationsAnswer> {
    return this.readConversations(user, "/api/zaru-conversations/", {
      limit: request.limit,
      current: request.current,
    });
  }

  /** One conversation, a page of messages from `cursor` (C1, C3, C8). */
  async readConversation(
    user: ZaruUser,
    request: ZaruConversationReadRequest,
  ): Promise<ZaruConversationsAnswer> {
    return this.readConversations(
      user,
      `/api/zaru-conversations/${encodeURIComponent(request.conversationId)}`,
      {
        cursor: request.cursor,
        page_size: request.pageSize,
        current: request.current,
      },
    );
  }

  /** A literal, case-insensitive search of the person's conversations (C1, C3). */
  async searchConversations(
    user: ZaruUser,
    request: ZaruConversationsSearchRequest,
  ): Promise<ZaruConversationsAnswer> {
    return this.readConversations(user, "/api/zaru-conversations/search", {
      q: request.query,
      limit: request.limit,
      current: request.current,
    });
  }

  /**
   * One GET of a conversation route. Only the parameters given are sent. A
   * 2xx JSON object is C1's output. Any other status is a refusal: its
   * `{ error, message }` body as Zaru Web sent it, or, when the body carries
   * no code, `unauthorized` for a 401, `conversation_not_found` for a 404 and
   * `unavailable` otherwise. A failed fetch (Zaru Web unreachable) and a 2xx
   * body that is not a JSON object throw.
   */
  private async readConversations(
    user: ZaruUser,
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<ZaruConversationsAnswer> {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) query.set(name, String(value));
    }
    const search = query.toString();
    const response = await this.fetchImpl(
      resolveUrl(this.baseUrl, search ? `${path}?${search}` : path),
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${user.token}`,
        },
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
          `zaru-client ${path} answered ${response.status} without a JSON object`,
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
              : CONVERSATION_REFUSAL_MESSAGES.unavailable,
        },
      };
    }
    const error =
      response.status === 401
        ? "unauthorized"
        : response.status === 404
          ? "conversation_not_found"
          : "unavailable";
    return {
      ok: false,
      status: response.status,
      refusal: { error, message: CONVERSATION_REFUSAL_MESSAGES[error] },
    };
  }
}
