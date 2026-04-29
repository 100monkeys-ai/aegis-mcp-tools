import type { ZaruUser } from "../middleware/auth.js";
import {
  buildSealEnvelope,
  createSessionId,
  createSessionKeyPair,
  type ZaruSealSession,
} from "./seal.js";
import type { AegisToolDefinition, JsonRpcRequest } from "./types.js";
import { log, logInfo } from "../logging.js";

const LOG_TOOL_ARGS = process.env.LOG_TOOL_ARGS === "true";

type FetchLike = typeof fetch;

interface AttestationResponse {
  security_token: string;
  expires_at?: string;
}

interface ToolDiscoveryCacheEntry {
  tools: AegisToolDefinition[];
  expiresAt: number;
}

export interface OrchestratorClientOptions {
  baseUrl?: string;
  toolDiscoveryUrl?: string;
  fetchImpl?: FetchLike;
  cacheTtlMs?: number;
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function resolveUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
}

function normalizeToolList(payload: unknown): AegisToolDefinition[] {
  if (Array.isArray(payload)) {
    return payload as AegisToolDefinition[];
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("Tool discovery response was not an object");
  }

  const objectPayload = payload as Record<string, unknown>;
  if (Array.isArray(objectPayload.tools)) {
    return objectPayload.tools as AegisToolDefinition[];
  }

  if (
    objectPayload.result &&
    typeof objectPayload.result === "object" &&
    Array.isArray((objectPayload.result as Record<string, unknown>).tools)
  ) {
    return (objectPayload.result as Record<string, unknown>)
      .tools as AegisToolDefinition[];
  }

  throw new Error("Tool discovery response did not contain a tools array");
}

/**
 * Thrown by `invokeJsonRpc` when the orchestrator returns a non-success
 * response that is not a recoverable session-expiry. Carries the raw
 * upstream `status` and (parsed when JSON, otherwise raw) `body` so the
 * caller can classify the failure (policy_denied vs upstream_error vs
 * timeout) and emit a structured log without re-parsing the error
 * message string.
 */
export class OrchestratorInvokeError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`AEGIS invoke failed: ${status}`);
    this.name = "OrchestratorInvokeError";
    this.status = status;
    this.body = body;
  }
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function normalizeToolCallResult(payload: unknown): unknown {
  if (
    payload &&
    typeof payload === "object" &&
    "result" in (payload as Record<string, unknown>) &&
    "jsonrpc" in (payload as Record<string, unknown>)
  ) {
    return (payload as Record<string, unknown>).result;
  }

  return payload;
}

export class OrchestratorClient {
  private readonly baseUrl: string;
  private readonly toolDiscoveryUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly cacheTtlMs: number;
  private readonly sessionCache = new Map<string, ZaruSealSession>();
  private readonly toolCache = new Map<string, ToolDiscoveryCacheEntry>();

  constructor(options: OrchestratorClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ??
        process.env.AEGIS_ORCHESTRATOR_URL ??
        "http://localhost:8088",
    );
    this.toolDiscoveryUrl =
      options.toolDiscoveryUrl ??
      process.env.AEGIS_TOOL_DISCOVERY_URL ??
      resolveUrl(this.baseUrl, "/v1/seal/tools");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cacheTtlMs =
      options.cacheTtlMs ?? Number(process.env.AEGIS_TOOL_CACHE_TTL_MS ?? 5000);
  }

  async listTools(user: ZaruUser): Promise<AegisToolDefinition[]> {
    const cacheKey = user.securityContext;
    const cached = this.toolCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.tools;
    }

    const discoveryResponse = await this.fetchImpl(this.toolDiscoveryUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Zaru-Security-Context": user.securityContext,
      },
    });

    if (discoveryResponse.ok) {
      const tools = normalizeToolList(await discoveryResponse.json());
      this.toolCache.set(cacheKey, {
        tools,
        expiresAt: now + this.cacheTtlMs,
      });
      return tools;
    }

    if (discoveryResponse.status !== 404 && discoveryResponse.status !== 405) {
      throw new Error(
        `Tool discovery failed: ${discoveryResponse.status} ${await discoveryResponse.text()}`,
      );
    }

    const result = await this.invokeJsonRpc(user, {
      jsonrpc: "2.0",
      id: "tools-list",
      method: "tools/list",
      params: {},
    });

    const tools = normalizeToolList(result);
    this.toolCache.set(cacheKey, {
      tools,
      expiresAt: now + this.cacheTtlMs,
    });
    return tools;
  }

  async streamExecution(
    user: ZaruUser,
    executionId: string,
  ): Promise<globalThis.Response> {
    const url = resolveUrl(
      this.baseUrl,
      `/v1/executions/${executionId}/events`,
    );

    return this.fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        Authorization: `Bearer ${user.token}`,
      },
    });
  }

  async invokeTool(
    user: ZaruUser,
    name: string,
    args: Record<string, unknown>,
    id: string | number | null,
    context: { requestId?: string } = {},
  ): Promise<unknown> {
    const start = process.hrtime.bigint();
    const baseFields: Record<string, unknown> = {
      request_id: context.requestId,
      tool_name: name,
      tenant_id: user.tenantId,
    };
    if (LOG_TOOL_ARGS) {
      // `log()` redacts sensitive fields automatically; this opt-in
      // exists for local debugging only.
      baseFields.args = args;
    }
    logInfo("tool.invoke.start", baseFields);

    try {
      const result = await this.invokeJsonRpc(user, {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name,
          arguments: args,
        },
      });
      const duration_ms = Number(
        (process.hrtime.bigint() - start) / 1_000_000n,
      );
      logInfo("tool.invoke.end", {
        request_id: context.requestId,
        tool_name: name,
        tenant_id: user.tenantId,
        status: "ok",
        duration_ms,
      });
      return result;
    } catch (error) {
      const duration_ms = Number(
        (process.hrtime.bigint() - start) / 1_000_000n,
      );
      let status: "policy_denied" | "upstream_error" | "timeout" =
        "upstream_error";
      let upstreamStatus: number | undefined;
      let upstreamBody: unknown;
      if (error instanceof OrchestratorInvokeError) {
        upstreamStatus = error.status;
        upstreamBody = error.body;
        if (error.status === 400) {
          // The SEAL gateway returns 400 with a structured policy
          // violation when a tool call is denied by the security
          // policy layer. Treat any non-session-expiry 400 as a
          // policy_denied; session-expiry 400s are retried inside
          // `invokeJsonRpc` and never surface here.
          status = "policy_denied";
        }
      } else if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        status = "timeout";
      }
      log(status === "policy_denied" ? "warn" : "error", "tool.invoke.end", {
        request_id: context.requestId,
        tool_name: name,
        tenant_id: user.tenantId,
        status,
        duration_ms,
        upstream_status: upstreamStatus,
        upstream_body: upstreamBody,
        error: error instanceof Error ? error : { message: String(error) },
      });
      throw error;
    }
  }

  private async invokeJsonRpc(
    user: ZaruUser,
    payload: JsonRpcRequest,
  ): Promise<unknown> {
    const session = await this.getOrCreateSession(user);
    const envelope = buildSealEnvelope(
      session.securityToken,
      payload,
      session.keyPair.privateKey,
    );
    const response = await this.fetchImpl(
      resolveUrl(this.baseUrl, "/v1/seal/invoke"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.securityToken}`,
        },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(330_000),
      },
    );

    const cacheKey = `${user.userId}:${user.tenantId ?? "personal"}`;
    if (response.status === 401 || response.status === 403) {
      this.sessionCache.delete(cacheKey);
      return this.invokeJsonRpcWithFreshSession(user, payload);
    }

    // Session expired returns as 400 with specific session error codes — re-attest
    if (response.status === 400) {
      const body = await response.text();
      if (
        body.includes("Session is inactive") ||
        body.includes("SessionExpired") ||
        body.includes("SessionInactive")
      ) {
        this.sessionCache.delete(cacheKey);
        return this.invokeJsonRpcWithFreshSession(user, payload);
      }
      throw new OrchestratorInvokeError(response.status, tryParseJson(body));
    }

    if (!response.ok) {
      const body = await response.text();
      throw new OrchestratorInvokeError(response.status, tryParseJson(body));
    }

    return normalizeToolCallResult(await response.json());
  }

  private async invokeJsonRpcWithFreshSession(
    user: ZaruUser,
    payload: JsonRpcRequest,
  ): Promise<unknown> {
    const session = await this.createSession(user);
    this.sessionCache.set(
      `${user.userId}:${user.tenantId ?? "personal"}`,
      session,
    );
    const envelope = buildSealEnvelope(
      session.securityToken,
      payload,
      session.keyPair.privateKey,
    );
    const response = await this.fetchImpl(
      resolveUrl(this.baseUrl, "/v1/seal/invoke"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.securityToken}`,
        },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(330_000),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new OrchestratorInvokeError(response.status, tryParseJson(body));
    }

    return normalizeToolCallResult(await response.json());
  }

  private async getOrCreateSession(user: ZaruUser): Promise<ZaruSealSession> {
    const cacheKey = `${user.userId}:${user.tenantId ?? "personal"}`;
    const existing = this.sessionCache.get(cacheKey);
    if (
      existing &&
      existing.securityContext === user.securityContext &&
      Date.now() < existing.expiresAt
    ) {
      return existing;
    }

    const session = await this.createSession(user);
    this.sessionCache.set(cacheKey, session);
    return session;
  }

  private async createSession(user: ZaruUser): Promise<ZaruSealSession> {
    if (!user.token) {
      // Hard requirement: /v1/seal/attest now authenticates the caller via
      // the orchestrator's JWT/API-key middleware and derives the SEAL
      // session tenant from the resolved UserIdentity (ADR-097). Without a
      // forwarded Bearer token the orchestrator cannot identify the user
      // and would fall back to a global tenant — which is the cross-tenant
      // leak this change closes. Refuse to attest rather than leak.
      throw new Error(
        "zaru-mcp-server: cannot attest SEAL session without user Bearer token",
      );
    }
    const sessionId = createSessionId();
    const keyPair = createSessionKeyPair();
    const response = await this.fetchImpl(
      resolveUrl(this.baseUrl, "/v1/seal/attest"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Forward the consumer user's own Bearer token (Keycloak JWT or
          // aegis_* API key) so the orchestrator's auth middleware can
          // resolve the authenticated UserIdentity and derive the canonical
          // tenant from its claims rather than defaulting to a global
          // singleton.
          Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify({
          workload_id: `zaru:${user.userId}:${sessionId}`,
          security_context: user.securityContext,
          ...(user.isOperator
            ? { aegis_role: user.tier }
            : { zaru_tier: user.tier }),
          // tenant_id is intentionally omitted: the orchestrator derives
          // the canonical tenant from the authenticated identity now. A
          // body-supplied tenant_id is tolerated-but-ignored by the
          // orchestrator for non-delegating callers (so deploy ordering of
          // the two repos does not matter).
          public_key: keyPair.publicKeyRaw.toString("base64"),
          container_id:
            process.env.CONTAINER_ID ??
            process.env.HOSTNAME ??
            "zaru-mcp-server",
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Attestation failed: ${response.status} ${await response.text()}`,
      );
    }

    const body = (await response.json()) as AttestationResponse;
    if (!body.security_token) {
      throw new Error("Attestation response did not include security_token");
    }

    const expiresAt = body.expires_at
      ? new Date(body.expires_at).getTime()
      : Date.now() + 50 * 60 * 1000;

    return {
      sessionId,
      securityToken: body.security_token,
      securityContext: user.securityContext,
      keyPair,
      expiresAt,
    };
  }
}
