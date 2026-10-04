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
   * ".wait") asks the orchestrator to block. Left out, there is no ceiling.
   * The Worker's entrypoint (src/worker.ts) passes WAIT_CEILING_SECONDS and
   * nothing else does, so the container's Express and SSE entrypoints keep
   * the orchestrator's own wait.
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

/** The orchestrator route an answer came from. */
export type AegisRoute = "invoke" | "attest" | "discovery";

/** The generic failure's words per route, followed by the HTTP status. */
const GENERIC_FAILURE: Record<AegisRoute, string> = {
  invoke: "AEGIS invoke failed",
  attest: "AEGIS attestation failed",
  discovery: "AEGIS tool discovery failed",
};

/**
 * Thrown by `invokeJsonRpc` (and by `createSession`, route `attest`) when the
 * orchestrator answers a non-success status. Carries the raw upstream
 * `status`, the (parsed when JSON, otherwise raw) `body` and the
 * `Retry-After` header, so `invokeTool` can classify the answer by
 * `relayFailure` and log it without re-parsing the message. The message
 * never holds the body.
 */
export class OrchestratorInvokeError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly route: AegisRoute;
  readonly retryAfter: string | null;
  constructor(
    status: number,
    body: unknown,
    options: { route?: AegisRoute; retryAfter?: string | null } = {},
  ) {
    const route = options.route ?? "invoke";
    super(`${GENERIC_FAILURE[route]}: ${status}`);
    this.name = "OrchestratorInvokeError";
    this.status = status;
    this.body = body;
    this.route = route;
    this.retryAfter = options.retryAfter ?? null;
  }
}

/**
 * AEGIS ADR-035, Update R1 to R8 (adrs/035-updates, revision 43571), R5's
 * table: each code of `POST /v1/seal/invoke` with its HTTP status and
 * whether it is a caller-facing refusal or an internal failure. A code is
 * relayed only at its own status (`aegis-orchestrator` 0c60875b,
 * `orchestrator/core/src/domain/seal_session.rs` 300-400).
 */
const R5_ROWS: Readonly<
  Record<string, { status: number; internal: boolean }>
> = {
  MALFORMED_ENVELOPE: { status: 400, internal: false },
  SIGNATURE_INVALID: { status: 401, internal: false },
  ENVELOPE_REPLAYED: { status: 401, internal: false },
  SESSION_INACTIVE: { status: 401, internal: false },
  SESSION_EXPIRED: { status: 401, internal: false },
  OPERATOR_ESCALATION_EXPIRED: { status: 401, internal: false },
  TOOL_NOT_ALLOWED: { status: 403, internal: false },
  TOOL_DENIED: { status: 403, internal: false },
  PATH_NOT_ALLOWED: { status: 403, internal: false },
  PATH_TRAVERSAL: { status: 403, internal: false },
  DOMAIN_NOT_ALLOWED: { status: 403, internal: false },
  COMMAND_NOT_ALLOWED: { status: 403, internal: false },
  SUBCOMMAND_NOT_ALLOWED: { status: 403, internal: false },
  POLICY_ARGUMENT_REQUIRED: { status: 403, internal: false },
  LIMIT_EXCEEDED: { status: 403, internal: false },
  RATE_LIMIT_EXCEEDED: { status: 429, internal: false },
  JUDGE_REJECTED: { status: 403, internal: false },
  TENANT_MISMATCH: { status: 403, internal: false },
  INVALID_ARGUMENTS: { status: 422, internal: false },
  QUOTA_EXCEEDED: { status: 422, internal: false },
  NOT_FOUND: { status: 404, internal: false },
  CONFLICT: { status: 409, internal: false },
  NOT_IMPLEMENTED: { status: 501, internal: false },
  EDGE_UNAVAILABLE: { status: 503, internal: false },
  INTERNAL_ERROR: { status: 500, internal: true },
  UPSTREAM_UNAVAILABLE: { status: 502, internal: true },
  SERVICE_UNAVAILABLE: { status: 503, internal: true },
};

/**
 * The fixed sentence of each internal class (R4, R5), the server's own copy:
 * an internal failure is told by this sentence, never by the body's message.
 */
const INTERNAL_SENTENCES: Readonly<Record<string, string>> = {
  INTERNAL_ERROR:
    "The request could not be completed because of an internal error.",
  UPSTREAM_UNAVAILABLE:
    "A service this tool depends on did not answer. Try again in a moment.",
  SERVICE_UNAVAILABLE: "This tool is not available right now.",
};

/**
 * What the caller is told of a 401 that survived the one re-attest and
 * retry: the orchestrator's sentence ("Attest again ...") is addressed to
 * this server, not to the person, so it goes only to the log.
 */
export const SESSION_NOT_RENEWED_MESSAGE =
  "The session with AEGIS could not be renewed. Try the call again.";

/** The code of an answer the relay does not trust. */
export const INVOKE_FAILED_CODE = "invoke_failed";

const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the caller is told of one orchestrator failure, and how it is logged. */
export interface RelayedFailure {
  /**
   * `refused`: a caller-facing row, relayed. `internal`: an internal row,
   * told by its fixed sentence. `session`: a 401 row after the re-attest.
   * `generic`: anything the relay does not trust.
   */
  kind: "refused" | "internal" | "session" | "generic";
  /** The body's `status` was `policy_violation`. */
  policy: boolean;
  code: string;
  message: string;
  requestId?: string;
  retryAfterSeconds?: number;
  /** The body's own `error.code` and `error.message`, for the log only. */
  upstreamCode?: string;
  upstreamMessage?: string;
}

/**
 * The relay rule (AEGIS ADR-035 R1 to R5). An answer is trusted only when
 * its body has ADR-035's shape (`protocol` "seal/v1", a UUID `request_id`,
 * `status` "policy_violation" or "error", an `error` object with string
 * `code` and `message`) and its (code, HTTP status) is a row of R5. Then a
 * caller-facing row relays `error.code` and `error.message`; an internal row
 * relays the code with the server's own sentence; a 401 row (one that
 * survived the re-attest) is told SESSION_NOT_RENEWED_MESSAGE. Anything else
 * is `invoke_failed` with the route's generic words and the status, and the
 * body's `request_id` only when it is a UUID. A 429's `Retry-After`, when a
 * whole number of seconds, is `retryAfterSeconds`.
 */
export function relayFailure(
  route: AegisRoute,
  httpStatus: number,
  body: unknown,
  retryAfter: string | null = null,
): RelayedFailure {
  const record = isPlainObject(body) ? body : null;
  const requestId =
    record &&
    typeof record.request_id === "string" &&
    REQUEST_ID_PATTERN.test(record.request_id)
      ? record.request_id
      : undefined;
  const error = record && isPlainObject(record.error) ? record.error : null;
  const shaped =
    record !== null &&
    record.protocol === "seal/v1" &&
    requestId !== undefined &&
    (record.status === "policy_violation" || record.status === "error") &&
    error !== null &&
    typeof error.code === "string" &&
    typeof error.message === "string";
  const code = shaped ? (error!.code as string) : undefined;
  const row = code !== undefined ? R5_ROWS[code] : undefined;
  const upstream = shaped
    ? {
        upstreamCode: error!.code as string,
        upstreamMessage: error!.message as string,
      }
    : {};
  if (!row || row.status !== httpStatus || code === undefined) {
    return {
      kind: "generic",
      policy: false,
      code: INVOKE_FAILED_CODE,
      message: `${GENERIC_FAILURE[route]}: ${httpStatus}`,
      ...(requestId ? { requestId } : {}),
      ...upstream,
    };
  }
  if (row.internal) {
    return {
      kind: "internal",
      policy: false,
      code,
      message: INTERNAL_SENTENCES[code]!,
      requestId,
      ...upstream,
    };
  }
  if (httpStatus === 401) {
    return {
      kind: "session",
      policy: false,
      code,
      message: SESSION_NOT_RENEWED_MESSAGE,
      requestId,
      ...upstream,
    };
  }
  const retryAfterSeconds =
    httpStatus === 429 && retryAfter !== null && /^\d+$/.test(retryAfter.trim())
      ? Number(retryAfter.trim())
      : undefined;
  return {
    kind: "refused",
    policy: record!.status === "policy_violation",
    code,
    message: error!.message as string,
    requestId,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...upstream,
  };
}

/**
 * The tool result an MCP client sees for a relayed failure: an ordinary
 * result with `isError` true and one text item,
 * `{"error":{"code","message"},"request_id"[,"retry_after_seconds"]}`.
 * The error is an object so that a reader taking `error.message` (Zaru Web,
 * `components/chat/tool-failure.ts`) shows the message.
 */
export function failureToolResult(failure: RelayedFailure): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const payload: Record<string, unknown> = {
    error: { code: failure.code, message: failure.message },
  };
  if (failure.requestId) payload.request_id = failure.requestId;
  if (failure.retryAfterSeconds !== undefined) {
    payload.retry_after_seconds = failure.retryAfterSeconds;
  }
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: true,
  };
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * Whether a 400 from `/v1/seal/invoke` says the session itself is no longer
 * usable, so that a new session cures it. The orchestrator answers every
 * invoke error but an ended escalation as 400 `{"error": <Display text>}`
 * (`aegis-orchestrator` 675984dc, `cli/src/daemon/handlers/seal.rs`
 * 605-610), and words its two session conditions
 * (`orchestrator/core/src/domain/seal_session.rs` 161-162) as
 * `"Session is inactive: {status:?}"` and `"Session has expired"`. Only
 * those texts, as the whole `error` field, are a session condition.
 */
function isSessionCondition(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const error = (body as Record<string, unknown>).error;
  return (
    typeof error === "string" &&
    (error === "Session has expired" ||
      error.startsWith("Session is inactive: "))
  );
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

/** A coded refusal, `{ error, message }`, as the orchestrator answered it. */
export interface OrchestratorRefusal {
  error: string;
  message: string;
  [field: string]: unknown;
}

/**
 * The orchestrator's answer on one of the operator escalation's routes
 * (Zaru ADR-0050 D3, D4): its JSON object on a 2xx, or its refusal. A
 * refusal it sent is carried unchanged (the record's Update U1); an
 * orchestrator that could not be reached, or answered without an object
 * carrying a string `error`, is `orchestrator_unavailable` with the status
 * seen (Update U2).
 */
export type OperatorEscalationAnswer =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; refusal: OrchestratorRefusal };

/** How long one escalation request may take before it is unavailable. */
const OPERATOR_ESCALATION_TIMEOUT_MS = 30_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function orchestratorUnavailable(message: string): OperatorEscalationAnswer {
  return { ok: false, refusal: { error: "orchestrator_unavailable", message } };
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
    this.waitCeilingSeconds = options.waitCeilingSeconds ?? null;
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

  /**
   * Redeem an operator escalation code for the key the caller presents:
   * `POST /v1/operator-escalations` with `{ code }` and the caller's own
   * token as Bearer (Zaru ADR-0050 D3; AEGIS ADR-129 D14). Never through
   * SEAL: the escalation is held by the key, not by a session.
   */
  redeemOperatorEscalation(
    user: ZaruUser,
    code: string,
  ): Promise<OperatorEscalationAnswer> {
    return this.operatorEscalationRequest(
      user,
      "POST",
      "/v1/operator-escalations",
      { code },
    );
  }

  /**
   * End the escalation the caller's key holds:
   * `DELETE /v1/operator-escalations/current` with the caller's own token
   * (Zaru ADR-0050 D4; AEGIS ADR-129 Update U5).
   */
  releaseOperatorEscalation(user: ZaruUser): Promise<OperatorEscalationAnswer> {
    return this.operatorEscalationRequest(
      user,
      "DELETE",
      "/v1/operator-escalations/current",
    );
  }

  private async operatorEscalationRequest(
    user: ZaruUser,
    method: "POST" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<OperatorEscalationAnswer> {
    let response: globalThis.Response;
    let text: string;
    try {
      response = await this.fetchImpl(resolveUrl(this.baseUrl, path), {
        method,
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          Authorization: `Bearer ${user.token}`,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(OPERATOR_ESCALATION_TIMEOUT_MS),
      });
      text = await response.text();
    } catch (error) {
      return orchestratorUnavailable(
        `The orchestrator could not be reached: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const parsed = tryParseJson(text);
    if (response.ok && isPlainObject(parsed)) {
      return { ok: true, body: parsed };
    }
    if (
      !response.ok &&
      isPlainObject(parsed) &&
      typeof parsed.error === "string"
    ) {
      return { ok: false, refusal: parsed as OrchestratorRefusal };
    }
    return orchestratorUnavailable(
      `The orchestrator answered HTTP ${response.status} without an error object.`,
    );
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
      if (error instanceof OrchestratorInvokeError) {
        // The orchestrator answered: the caller gets a tool result by the
        // relay rule, never a JSON-RPC error. A caller-facing refusal is
        // logged at info (ADR-035 R3's level; a 403 or 429 policy refusal as
        // policy_denied), a 401 that survived the re-attest at warn with the
        // orchestrator's own sentence, and an internal or untrusted answer at
        // error with the whole body.
        const relayed = relayFailure(
          error.route,
          error.status,
          error.body,
          error.retryAfter,
        );
        const [level, status] =
          relayed.kind === "refused"
            ? (["info", relayed.policy ? "policy_denied" : "refused"] as const)
            : relayed.kind === "session"
              ? (["warn", "session_not_renewed"] as const)
              : (["error", "upstream_error"] as const);
        log(level, "tool.invoke.end", {
          request_id: context.requestId,
          tool_name: name,
          tenant_id: user.tenantId,
          status,
          duration_ms,
          upstream_route: error.route,
          upstream_status: error.status,
          upstream_code: relayed.upstreamCode,
          upstream_request_id: relayed.requestId,
          upstream_message: relayed.upstreamMessage,
          upstream_body: error.body,
        });
        return failureToolResult(relayed);
      }
      const status =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
          ? "timeout"
          : "upstream_error";
      log("error", "tool.invoke.end", {
        request_id: context.requestId,
        tool_name: name,
        tenant_id: user.tenantId,
        status,
        duration_ms,
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
    if (response.status === 401) {
      this.sessionCache.delete(cacheKey);
      return this.invokeJsonRpcWithFreshSession(user, payload);
    }

    if (!response.ok) {
      const body = tryParseJson(await response.text());
      if (response.status === 400 && isSessionCondition(body)) {
        this.sessionCache.delete(cacheKey);
        return this.invokeJsonRpcWithFreshSession(user, payload);
      }
      // A 403 is a refusal of the call itself (a policy, tenant or judge
      // refusal): a new session does not cure it, so it is not re-attested.
      throw new OrchestratorInvokeError(response.status, body, {
        retryAfter: response.headers.get("retry-after"),
      });
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
      throw new OrchestratorInvokeError(response.status, tryParseJson(body), {
        retryAfter: response.headers.get("retry-after"),
      });
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
