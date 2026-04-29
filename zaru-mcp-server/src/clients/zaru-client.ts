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
 * HTTP client for the zaru-client `/api/zaru-memory` REST surface (ADR-118).
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
    this.fetchImpl = options.fetchImpl ?? fetch;
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
}
