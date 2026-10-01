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
  /**
   * The longest, in seconds, one call of a wait tool (a name ending in
   * ".wait") asks the orchestrator to block. `null` sets no ceiling. Left
   * out, it is WAIT_CEILING_SECONDS on the Workers runtime and none
   * elsewhere, so the container's Express and SSE entrypoints keep the
   * orchestrator's own wait.
   */
  waitCeilingSeconds?: number | null;
}

/**
 * The wait ceiling on the Worker. An MCP client gives up on a tool call after
 * about a minute (Claude Code's ended a 240-second `aegis.task.wait` as "The
 * operation timed out" in under 75 seconds while 40-, 45- and 50-second calls
 * answered; AEGIS known-defects-4), and the orchestrator's waits block for up
 * to their own defaults of 300 seconds or more. 45 seconds answers inside
 * that limit; a caller continues by repeating the call.
 */
export const WAIT_CEILING_SECONDS = 45;

export function isWaitTool(name: string): boolean {
  return name.endsWith(".wait");
}

/** True in the Cloudflare Workers runtime, by its documented user agent. */
function onWorkersRuntime(): boolean {
  const nav = (globalThis as { navigator?: { userAgent?: unknown } })
    .navigator;
  return nav?.userAgent === "Cloudflare-Workers";
}

/**
 * The arguments a wait tool's call is forwarded with under `ceiling`, and the
 * seconds the orchestrator is asked to wait. A `timeout_seconds` the
 * orchestrator would read (a whole number, `as_u64`) at or under the ceiling
 * is honoured; anything else, absent included, becomes the ceiling, since the
 * orchestrator would otherwise wait its own default.
 */
export function boundWaitArguments(
  args: Record<string, unknown>,
  ceiling: number,
): { args: Record<string, unknown>; waitSeconds: number } {
  const requested = args.timeout_seconds;
  if (
    typeof requested === "number" &&
    Number.isInteger(requested) &&
    requested >= 0 &&
    requested <= ceiling
  ) {
    return { args, waitSeconds: requested };
  }
  return { args: { ...args, timeout_seconds: ceiling }, waitSeconds: ceiling };
}

/** The orchestrator's wait answer as an object, from either form it takes. */
function readWaitAnswer(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.content)) return record;
  const first = record.content[0] as { type?: unknown; text?: unknown };
  if (record.content.length !== 1 || first?.type !== "text") return null;
  if (typeof first.text !== "string") return null;
  const parsed = tryParseJson(first.text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/**
 * When the orchestrator's wait ended at its timeout with the execution still
 * running, the tool result that says so and how to continue; otherwise null,
 * and the orchestrator's result goes back unchanged.
 */
export function stillRunningResult(
  toolName: string,
  result: unknown,
  waitSeconds: number,
): unknown | null {
  const answer = readWaitAnswer(result);
  if (!answer || answer.timed_out !== true) return null;
  const executionId = answer.execution_id;
  const status = typeof answer.status === "string" ? answer.status : "running";
  const progress =
    typeof answer.iteration_count === "number"
      ? `, iteration count ${answer.iteration_count}`
      : typeof answer.current_state === "string"
        ? `, in state ${answer.current_state}`
        : "";
  const body: Record<string, unknown> = {
    tool: toolName,
    execution_id: executionId,
    status,
    ...(answer.iteration_count !== undefined
      ? { iteration_count: answer.iteration_count }
      : {}),
    ...(answer.current_state !== undefined
      ? { current_state: answer.current_state }
      : {}),
    still_running: true,
    timed_out: true,
    waited_seconds: waitSeconds,
    message:
      `Execution ${String(executionId)} is still ${status} after ${waitSeconds}s${progress}. ` +
      `Repeat this same ${toolName} call to continue waiting.`,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
    isError: false,
  };
}

function describeWaitCeiling(
  tool: AegisToolDefinition,
  ceiling: number,
): AegisToolDefinition {
  const sentence =
    `On this server one call waits at most ${ceiling} seconds, whatever timeout_seconds asks: ` +
    `if the execution is still running then, the result says so, and repeating the same call continues the wait.`;
  return {
    ...tool,
    description: tool.description ? `${tool.description} ${sentence}` : sentence,
  };
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

/**
 * The orchestrator issues execution ids as UUIDs and its execution routes
 * parse the path segment as `Uuid`. An id in any other shape can never
 * name an execution. Refusing it here keeps a caller-supplied string from
 * becoming part of the upstream URL's structure. Express decodes the route
 * param, so a slash, backslash, `?` or `#` in it would otherwise re-route
 * the proxied request.
 */
const EXECUTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidExecutionIdError extends Error {
  constructor() {
    super("executionId must be a UUID");
    this.name = "InvalidExecutionIdError";
  }
}

export class OrchestratorClient {
  private readonly baseUrl: string;
  private readonly toolDiscoveryUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly cacheTtlMs: number;
  private readonly sessionCache = new Map<string, ZaruSealSession>();
  private readonly toolCache = new Map<string, ToolDiscoveryCacheEntry>();
  private readonly waitCeilingSeconds: number | null;

  constructor(options: OrchestratorClientOptions = {}) {
    this.waitCeilingSeconds =
      options.waitCeilingSeconds !== undefined
        ? options.waitCeilingSeconds
        : onWorkersRuntime()
          ? WAIT_CEILING_SECONDS
          : null;
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ??
        process.env.AEGIS_ORCHESTRATOR_URL ??
        "http://localhost:8088",
    );
    this.toolDiscoveryUrl =
      options.toolDiscoveryUrl ??
      process.env.AEGIS_TOOL_DISCOVERY_URL ??
      resolveUrl(this.baseUrl, "/v1/seal/tools");
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.cacheTtlMs =
      options.cacheTtlMs ?? Number(process.env.AEGIS_TOOL_CACHE_TTL_MS ?? 5000);
  }

  async listTools(user: ZaruUser): Promise<AegisToolDefinition[]> {
    const tools = await this.discoverTools(user);
    const ceiling = this.waitCeilingSeconds;
    if (ceiling === null) return tools;
    return tools.map((tool) =>
      isWaitTool(tool.name) ? describeWaitCeiling(tool, ceiling) : tool,
    );
  }

  private async discoverTools(user: ZaruUser): Promise<AegisToolDefinition[]> {
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
    if (!EXECUTION_ID_PATTERN.test(executionId)) {
      throw new InvalidExecutionIdError();
    }
    const url = resolveUrl(
      this.baseUrl,
      `/v1/executions/${encodeURIComponent(executionId)}/events`,
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

    const ceiling = this.waitCeilingSeconds;
    const bounded =
      ceiling !== null && isWaitTool(name)
        ? boundWaitArguments(args, ceiling)
        : null;

    try {
      const upstream = await this.invokeJsonRpc(user, {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name,
          arguments: bounded ? bounded.args : args,
        },
      });
      const result = bounded
        ? (stillRunningResult(name, upstream, bounded.waitSeconds) ?? upstream)
        : upstream;
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
          // No container_id: the server is not a container on the
          // orchestrator's runtime (it runs as a Cloudflare Worker, Zaru
          // ADR-0045), and a container_id makes the orchestrator inspect that
          // name and refuse. The caller's Bearer is the identity;
          // workload_id carries the audit correlation.
          public_key: keyPair.publicKeyRaw.toString("base64"),
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
