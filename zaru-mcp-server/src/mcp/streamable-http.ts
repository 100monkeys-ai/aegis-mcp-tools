import type { Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  isApiKey,
  type ZaruRequest,
  type ZaruUser,
} from "../middleware/auth.js";
import {
  OrchestratorClient,
  type OperatorEscalationAnswer,
} from "./orchestrator-client.js";
import { ZaruClient, VersionConflictError } from "../clients/zaru-client.js";
import {
  getZaruInit,
  appendMemoryToSystemPrompt,
  allowedModesFor,
} from "../prompts/index.js";
import { searchDocs } from "../docs/index.js";
import { logError, logWarn } from "../logging.js";

const orchestratorClient = new OrchestratorClient();

// Zaru User Memory client (ADR-118). Constructed once at module init from
// `ZARU_CLIENT_URL`. If the env var is missing we surface a clear error and
// still construct the client against its default `http://localhost:3000`
// fallback — the per-call HTTP errors will then localize the failure rather
// than blocking module import on a config drift.
if (!process.env.ZARU_CLIENT_URL) {
  logWarn("config.missing_env", {
    var: "ZARU_CLIENT_URL",
    impact:
      "Zaru User Memory (zaru.memory.get/set, system-prompt injection) will fail until configured",
  });
}
const zaruClient = new ZaruClient();

/**
 * Extract an array of script DTOs from an `aegis.script.list` tool result.
 *
 * The SEAL-gateway wraps orchestrator responses in an MCP tool-call envelope:
 *   `{ content: [{ type: "text", text: "<JSON string>" }], isError: false }`
 * — where the `text` holds the JSON-serialized array returned by the
 * orchestrator's `GET /v1/scripts` endpoint. We also tolerate direct arrays
 * and `{type: "json"}` envelopes in case upstream shapes change.
 */
export function extractScriptsArray(
  result: unknown,
): Array<{ id: string; name: string }> {
  if (Array.isArray(result)) {
    return result as Array<{ id: string; name: string }>;
  }
  if (!result || typeof result !== "object") {
    return [];
  }
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content) && r.content[0]) {
    const first = r.content[0] as Record<string, unknown>;
    if (first.type === "text" && typeof first.text === "string") {
      try {
        const parsed = JSON.parse(first.text);
        if (Array.isArray(parsed)) {
          return parsed as Array<{ id: string; name: string }>;
        }
      } catch {
        // fall through — not valid JSON, return empty
      }
    }
    if (
      first.type === "json" &&
      first.json &&
      Array.isArray(first.json as unknown)
    ) {
      return first.json as Array<{ id: string; name: string }>;
    }
  }
  return [];
}

/**
 * Dispatch `zaru.script.save` / `zaru.script.run` onto the orchestrator via the
 * SEAL-gateway `aegis.script.*` native tools.
 *
 * `zaru.script.save` is a thin pass-through to `aegis.script.save`.
 * `zaru.script.run` loads the script DTO (by `id` or by `name` via
 * `aegis.script.list` + exact-match resolution) and returns it to the LLM so
 * the caller can execute the `code` field via `zaru.execute_typescript`.
 *
 * Exported for unit testing.
 */
export async function handleZaruScriptTool(
  client: Pick<OrchestratorClient, "invokeTool">,
  user: ZaruUser,
  name: "zaru.script.save" | "zaru.script.run",
  args: unknown,
  requestId?: string,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  if (name === "zaru.script.save") {
    const result = await client.invokeTool(
      user,
      "aegis.script.save",
      (args as Record<string, unknown>) ?? {},
      null,
      { requestId },
    );
    return normalizeToolResult(result);
  }

  // zaru.script.run
  const a = (args as Record<string, unknown>) ?? {};
  const scriptId = typeof a.id === "string" ? a.id : undefined;
  const scriptName = typeof a.name === "string" ? a.name : undefined;

  if (!scriptId && !scriptName) {
    return normalizeToolResult({
      isError: true,
      content: [
        {
          type: "text",
          text: "zaru.script.run requires either 'id' or 'name' to look up the script.",
        },
      ],
    });
  }

  let resolvedId = scriptId;
  if (!resolvedId && scriptName) {
    const listResult = await client.invokeTool(
      user,
      "aegis.script.list",
      { q: scriptName },
      null,
      { requestId },
    );
    const scripts = extractScriptsArray(listResult);
    const matches = scripts.filter(
      (s) => s.name?.toLowerCase() === scriptName.toLowerCase(),
    );
    if (matches.length === 0) {
      return normalizeToolResult({
        isError: true,
        content: [
          {
            type: "text",
            text: `No saved script named "${scriptName}".`,
          },
        ],
      });
    }
    if (matches.length > 1) {
      return normalizeToolResult({
        isError: true,
        content: [
          {
            type: "text",
            text: `Multiple saved scripts match "${scriptName}". Specify by id instead: ${matches
              .map((m) => m.id)
              .join(", ")}.`,
          },
        ],
      });
    }
    resolvedId = matches[0].id;
  }

  const scriptResult = await client.invokeTool(
    user,
    "aegis.script.get",
    { id: resolvedId },
    null,
    { requestId },
  );
  return normalizeToolResult(scriptResult);
}

function normalizeToolResult(result: unknown): {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
} {
  if (
    result &&
    typeof result === "object" &&
    (("content" in (result as Record<string, unknown>) &&
      Array.isArray((result as Record<string, unknown>).content)) ||
      "structuredContent" in (result as Record<string, unknown>))
  ) {
    return result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
  }

  return {
    content: [
      {
        type: "text",
        text:
          typeof result === "string" ? result : JSON.stringify(result, null, 2),
      },
    ],
    isError: false,
  };
}

/**
 * Fetch the user's Zaru User Memory (ADR-118) and append it to the
 * `system_prompt` of an already-resolved `ZaruInitResponse`. If the
 * fetch fails (network / zaru-client unreachable) the prompt is
 * returned unchanged and a warning is logged — memory injection
 * MUST NOT block session init.
 *
 * Exported for unit testing. The `client` parameter accepts any object
 * with a `getMemory(user)` method so tests can inject a fake without
 * standing up a real `ZaruClient`. The `logger` parameter defaults to
 * `console` and exists so tests can capture warnings.
 */
export async function injectMemoryIntoInit<T extends { system_prompt: string }>(
  client: Pick<ZaruClient, "getMemory">,
  user: ZaruUser,
  init: T,
  logger: Pick<Console, "warn"> = console,
): Promise<T> {
  try {
    const memory = await client.getMemory(user);
    return {
      ...init,
      system_prompt: appendMemoryToSystemPrompt(init.system_prompt, memory),
    };
  } catch (error) {
    logger.warn(
      "[zaru-mcp-server] failed to fetch Zaru User Memory — proceeding without injection:",
      error instanceof Error ? error.message : error,
    );
    return init;
  }
}

/**
 * Dispatch `zaru.memory.get` — fetch the user's Zaru User Memory record
 * (ADR-118) and wrap it in the standard MCP tool-call envelope. Errors
 * are surfaced as structured tool errors rather than thrown so the LLM
 * can react.
 *
 * Exported for unit testing.
 */
export async function handleZaruMemoryGet(
  client: Pick<ZaruClient, "getMemory">,
  user: ZaruUser,
  logger: Pick<Console, "error"> = console,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  try {
    const memory = await client.getMemory(user);
    return normalizeToolResult(memory);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "zaru.memory.get failed";
    logger.error("[zaru.memory.get] failed:", message);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
}

/**
 * Dispatch `zaru.memory.set` — replace the user's Zaru User Memory
 * (ADR-118) with optimistic concurrency on `version`. On
 * `VersionConflictError` we return a structured tool error containing
 * the server's current `{ content, version, updated_at }` so the LLM
 * can re-read, merge, and retry. All other failure modes (missing
 * args, network error, generic upstream error) produce structured
 * tool errors rather than throwing.
 *
 * Exported for unit testing.
 */
export async function handleZaruMemorySet(
  client: Pick<ZaruClient, "setMemory">,
  user: ZaruUser,
  args: unknown,
  logger: Pick<Console, "error"> = console,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  const a = (args as Record<string, unknown>) ?? {};
  const content = typeof a.content === "string" ? a.content : undefined;
  const version = typeof a.version === "number" ? a.version : undefined;
  if (content === undefined || version === undefined) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error:
              "zaru.memory.set requires both 'content' (string) and 'version' (number from the latest zaru.memory.get).",
          }),
        },
      ],
      isError: true,
    };
  }
  try {
    const updated = await client.setMemory(user, content, version);
    return normalizeToolResult(updated);
  } catch (error) {
    if (error instanceof VersionConflictError) {
      // Structured conflict so the LLM can re-read, merge, retry.
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "version_conflict",
              message:
                "Memory was updated by another writer. Re-read, merge your update into the new content, and retry with the new version.",
              current: error.current,
            }),
          },
        ],
        isError: true,
      };
    }
    const message =
      error instanceof Error ? error.message : "zaru.memory.set failed";
    logger.error("[zaru.memory.set] failed:", message);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: message }) }],
      isError: true,
    };
  }
}

/**
 * The header Zaru Web's MCP connection sends on every request it makes for
 * a turn of the companion (`zaru-client` 60db5a3). A request carrying it is
 * part of a turn, and `zaru.chat` is refused on it, so a turn can never start
 * another turn (Zaru ADR-0049 D6).
 */
export const ZARU_TURN_HEADER = "x-zaru-turn";

/**
 * Whether a request carries `x-zaru-turn`, from the header's value as the
 * entrypoint reads it: Express's `req.headers[...]` (absent is `undefined`)
 * or the Fetch API's `headers.get(...)` (absent is `null`). Presence is what
 * counts, whatever the value.
 */
export function carriesZaruTurn(
  headerValue: string | string[] | null | undefined,
): boolean {
  return headerValue !== undefined && headerValue !== null;
}

/** The modes a turn may run in through `zaru.chat` (Zaru ADR-0049 D6). */
export const ZARU_CHAT_MODES = ["chat", "agentic", "workflow", "execute"];

/** The most characters `message` may hold (Zaru ADR-0049 D7). */
export const ZARU_CHAT_MAX_MESSAGE_CHARS = 32768;

/** The listing of `zaru.chat`, D1's input schema (Zaru ADR-0049). */
export const ZARU_CHAT_TOOL = {
  name: "zaru.chat",
  description: `Run one turn of the Zaru companion on Zaru's own model, in one of your stored Zaru Web conversations, and return its answer. The turn is the same one the chat page at ask.myzaru.com runs: the companion's prompt, your memory, and the tools of the mode; the conversation is stored with your others, listed on the page and continued there or here.

Send \`message\`. Pass \`conversation_id\` to continue a conversation begun on the page or by an earlier call; without it a new conversation is started and its id returned. Pass \`mode\` (chat, agentic, workflow or execute) to run the turn in that mode; without it the conversation's stored mode is used, or chat for a new one.

One call runs one turn of at most five model calls, bounded so the call answers within the minute an MCP client waits: Zaru Web starts no model call after 40 seconds and ends the turn at 50 seconds with status "incomplete", everything done so far stored. In agentic mode, when the answer carries goal (set by a turn that created or ran an agent), Zaru judges the work after the call has answered and continues it by itself while the goal is not met and its bounds allow: send no "keep going"; wait, and read the goal's state with aegis.goal.status where it is listed. Otherwise, send your next message in the same conversation to continue. status says only whether the turn reached its time limit; whether the work is done is the goal's state: open, then met, cannot_be_met, exhausted, expired or superseded. A tool call that needs approval comes back with outcome "approval_pending" and its approval_id, for the person to answer on Zaru Web. A mode switch the companion asks for is returned as mode_switch_requested and not applied.

Returns { conversation_id, status, answer, tool_calls, model, mode, mode_switch_requested?, usage?, goal? }, goal being { goal_id, statement, state, rounds, verdicts } when the turn holds an open goal, each verdict { round, score, confidence, outcome, reasoning } with round the round it judged. A refusal is an error whose text is { error, message }, the error one of unauthorized, conversation_not_found, conversation_archived, active_execution_exists, mode_not_available, inference_unavailable, turn_failed.`,
  inputSchema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        minLength: 1,
        maxLength: ZARU_CHAT_MAX_MESSAGE_CHARS,
        description: "Your message for this turn.",
      },
      conversation_id: {
        type: "string",
        format: "uuid",
        description:
          "A conversation of yours to continue, begun on the page or through this tool. Absent: a new conversation is started.",
      },
      mode: {
        type: "string",
        enum: ZARU_CHAT_MODES,
        description:
          "The conversation mode of this turn. Absent: the conversation's stored mode, or chat for a new conversation. A different mode changes the conversation's mode.",
      },
    },
    required: ["message"],
  },
};

type ZaruChatResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
};

function zaruChatRefusal(refusal: {
  error: string;
  message: string;
}): ZaruChatResult {
  return {
    content: [{ type: "text", text: JSON.stringify(refusal) }],
    isError: true,
  };
}

/**
 * Dispatch `zaru.chat` (Zaru ADR-0049): one turn of the companion, run by
 * Zaru Web's `POST /api/chat/turn` with the caller's own token. Answered
 * here and never forwarded to the orchestrator.
 *
 * - On a request carrying `x-zaru-turn` (`inTurn`) the call is refused with
 *   `mode_not_available` before any fetch: `zaru.chat` is in no mode's tools
 *   (D6), and a turn must not start another.
 * - Zaru Web's 2xx answer, D1's output object, is returned as one text item
 *   and as `structuredContent`.
 * - A refusal is returned as a tool error whose text is its `{ error,
 *   message }`.
 * - Zaru Web unreachable, or answering a 2xx that is not a JSON object, is a
 *   tool error with `turn_failed`.
 *
 * Exported for unit testing.
 */
export async function handleZaruChat(
  client: Pick<ZaruClient, "chat">,
  user: ZaruUser,
  args: unknown,
  inTurn: boolean,
): Promise<ZaruChatResult> {
  if (inTurn) {
    return zaruChatRefusal({
      error: "mode_not_available",
      message:
        "zaru.chat is in no mode's tools: a turn of the companion cannot start another turn (the request carries x-zaru-turn).",
    });
  }

  const a = (args as Record<string, unknown>) ?? {};
  try {
    const answer = await client.chat(user, {
      message: a.message,
      conversationId: a.conversation_id,
      mode: a.mode,
    });
    if (!answer.ok) {
      logWarn("zaru.chat.refused", {
        upstream_status: answer.status,
        code: answer.refusal.error,
      });
      return zaruChatRefusal(answer.refusal);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(answer.output) }],
      structuredContent: answer.output,
      isError: false,
    };
  } catch (error) {
    logError("zaru.chat.failed", {
      error: error instanceof Error ? error : { message: String(error) },
    });
    return zaruChatRefusal({
      error: "turn_failed",
      message: `Zaru Web could not run the turn: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

/** D3's code: six decimal digits (Zaru ADR-0050). */
export const OPERATOR_CODE_PATTERN = "^[0-9]{6}$";
const OPERATOR_CODE = new RegExp(OPERATOR_CODE_PATTERN);

/**
 * The listing of `zaru.operator.escalate` (Zaru ADR-0050 D3): listed to every
 * API-key caller, since only an API key can hold an escalation (AEGIS ADR-129
 * D11) and the server cannot tell an operator's key from anyone else's before
 * the orchestrator answers.
 */
export const ZARU_OPERATOR_ESCALATE_TOOL = {
  name: "zaru.operator.escalate",
  description: `Escalate this connection to the AEGIS operator tools with the one-time code an operator generates on Zaru Web's operator page (ask.myzaru.com, in the stepped-up operator session). Ask the person for the six-digit code shown on that page and pass it as \`code\`; never guess or invent a code: a wrong code counts against the person's code, and enough wrong attempts invalidate it.

The code is valid once and only for a few minutes after it is generated. The escalation is held by the API key this connection presents and lasts until \`expires_at\` (30 minutes by default); list the tools again to see the operator tools, and call zaru.operator.release to end it early. Only an operator's own API key, created from their consumer session, can be escalated.

Returns { aegis_role, expires_at }. A refusal is an error whose text is { error, message }, the error one of invalid_code, code_expired, escalation_requires_api_key, orchestrator_unavailable.`,
  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        pattern: OPERATOR_CODE_PATTERN,
        description:
          "The six-digit code shown on Zaru Web's operator page, exactly as the person gives it.",
      },
    },
    required: ["code"],
  },
};

/**
 * The listing of `zaru.operator.release` (Zaru ADR-0050 D4): listed only
 * while the presenting key holds an escalation (D5).
 */
export const ZARU_OPERATOR_RELEASE_TOOL = {
  name: "zaru.operator.release",
  description: `End this connection's operator escalation now, instead of at its expiry. The operator tools leave the tool list at the next listing; a call that arrives after the end is refused by AEGIS.

Returns { ended_at }. A refusal is an error whose text is { error, message }, the error one of escalation_not_found, orchestrator_unavailable.`,
  inputSchema: {
    type: "object",
    properties: {},
  },
};

type OperatorToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
};

function operatorToolResult(
  answer: OperatorEscalationAnswer,
  fields: string[],
): OperatorToolResult {
  if (!answer.ok) {
    // Relayed unchanged (Zaru ADR-0050, Update U1 and U2).
    return {
      content: [{ type: "text", text: JSON.stringify(answer.refusal) }],
      isError: true,
    };
  }
  const output: Record<string, unknown> = {};
  for (const field of fields) output[field] = answer.body[field];
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output,
    isError: false,
  };
}

/**
 * Dispatch `zaru.operator.escalate` (Zaru ADR-0050 D3): post the code to the
 * orchestrator with the caller's own token and return the escalation's role
 * and end, or the orchestrator's refusal unchanged. A code that is not six
 * decimal digits is refused `invalid_code` here and never sent, so it does
 * not count against the user's live codes (the record's Update U3).
 *
 * Exported for unit testing.
 */
export async function handleOperatorEscalate(
  client: Pick<OrchestratorClient, "redeemOperatorEscalation">,
  user: ZaruUser,
  args: unknown,
): Promise<OperatorToolResult> {
  const code = (args as Record<string, unknown> | undefined)?.code;
  if (typeof code !== "string" || !OPERATOR_CODE.test(code)) {
    return operatorToolResult(
      {
        ok: false,
        refusal: {
          error: "invalid_code",
          message:
            "The code is six decimal digits, exactly as Zaru Web's operator page shows it.",
        },
      },
      [],
    );
  }
  const answer = await client.redeemOperatorEscalation(user, code);
  if (!answer.ok) {
    logWarn("zaru.operator.escalate.refused", { code: answer.refusal.error });
  }
  return operatorToolResult(answer, ["aegis_role", "expires_at"]);
}

/**
 * Dispatch `zaru.operator.release` (Zaru ADR-0050 D4): end the escalation the
 * caller's key holds and return its end, or the orchestrator's refusal
 * unchanged.
 *
 * Exported for unit testing.
 */
export async function handleOperatorRelease(
  client: Pick<OrchestratorClient, "releaseOperatorEscalation">,
  user: ZaruUser,
): Promise<OperatorToolResult> {
  const answer = await client.releaseOperatorEscalation(user);
  if (!answer.ok) {
    logWarn("zaru.operator.release.refused", { code: answer.refusal.error });
  }
  return operatorToolResult(answer, ["ended_at"]);
}

/**
 * Tool calls that may carry an `attachments` array per ADR-113. Only clients
 * that declare the "chat-uploads" capability are permitted to forward
 * attachments to these tools — defence-in-depth on top of the orchestrator and
 * the Zaru web client gates.
 */
export const ATTACHMENT_CAPABLE_TOOLS: ReadonlySet<string> = new Set([
  "aegis.task.execute",
  "aegis.agent.generate",
  "aegis.execute.intent",
]);

/**
 * Returns true if a tool call payload includes a non-empty `attachments` field
 * — either at the top level or nested under `input` (the conventional shape
 * for `aegis.task.execute` / `aegis.agent.generate` / `aegis.execute.intent`).
 */
export function hasAttachments(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  const a = args as Record<string, unknown>;
  if (Array.isArray(a.attachments) && a.attachments.length > 0) return true;
  const input = a.input;
  if (input && typeof input === "object") {
    const i = input as Record<string, unknown>;
    if (Array.isArray(i.attachments) && i.attachments.length > 0) return true;
  }
  const inputs = a.inputs;
  if (inputs && typeof inputs === "object") {
    const i = inputs as Record<string, unknown>;
    if (Array.isArray(i.attachments) && i.attachments.length > 0) return true;
  }
  return false;
}

/**
 * ADR-113 defence-in-depth predicate. Returns true when an MCP `tools/call`
 * payload carries attachments to an attachment-capable tool from a client
 * that has NOT declared the "chat-uploads" capability.
 *
 * All three conditions MUST hold to reject:
 *   1. The tool name is in `ATTACHMENT_CAPABLE_TOOLS`.
 *   2. The payload actually contains a non-empty `attachments` array.
 *   3. The caller has not declared `chat-uploads`.
 *
 * Calls without attachments — regardless of tool name or capability state —
 * MUST pass through. Locking external MCP clients out of normal use of
 * `aegis.agent.generate` / `aegis.task.execute` / `aegis.execute.intent`
 * was the regression this predicate is written to prevent.
 */
export function shouldRejectAttachments(
  toolName: string,
  args: unknown,
  capabilities: ReadonlySet<string>,
): boolean {
  return (
    ATTACHMENT_CAPABLE_TOOLS.has(toolName) &&
    hasAttachments(args) &&
    !capabilities.has("chat-uploads")
  );
}

/**
 * Resolve the canonical capability set for a tool call.
 *
 * Per the ADR-110 amendment / ADR-113 correction wave, `X-Zaru-Capabilities`
 * is the canonical capability transport. The `client.capabilities` array on
 * `zaru.init` / `zaru.mode` tool args remains for backward compatibility with
 * external MCP clients (Claude Code, Windsurf, etc.) that may not send the
 * header. Merge policy:
 *
 *   1. Header present and non-empty   → use header, ignore tool args.
 *   2. Header empty + args present    → use tool args (legacy fallback).
 *   3. Both empty                     → empty set (base prompts; gate rejects
 *                                        attachment-bearing requests).
 *
 * The header always wins when both are populated, so a future Zaru-internal
 * capability change only needs to update the header — `client.capabilities`
 * cannot drift it back into a degraded state.
 *
 * Exported for unit testing.
 */
export function resolveCapabilities(
  headerCapabilities: ReadonlySet<string>,
  argClientCapabilities: unknown,
): Set<string> {
  if (headerCapabilities.size > 0) {
    return new Set(headerCapabilities);
  }
  if (Array.isArray(argClientCapabilities)) {
    const out = new Set<string>();
    for (const c of argClientCapabilities) {
      if (typeof c === "string") {
        const t = c.trim().toLowerCase();
        if (t.length > 0) out.add(t);
      }
    }
    return out;
  }
  return new Set();
}

/**
 * Parse the `X-Zaru-Capabilities` HTTP header into a normalized capability
 * Set. The header is a comma-separated list (e.g. `chat-uploads,live,vibecode`).
 * Each token is trimmed and lowercased so that the canonical lowercase form
 * (matching ADR-113 / ADR-110 capability identifiers) is the only value the
 * gate ever sees. Missing, empty, or non-string headers yield an empty Set —
 * which the gate treats as "no capabilities declared".
 *
 * Exported for unit testing.
 */
export function parseCapabilitiesHeader(
  headerValue: string | string[] | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!headerValue) return out;
  // Express may surface a repeated header as `string[]`; flatten to a single
  // comma-joined string before tokenizing.
  const raw = Array.isArray(headerValue) ? headerValue.join(",") : headerValue;
  for (const token of raw.split(",")) {
    const t = token.trim().toLowerCase();
    if (t.length > 0) out.add(t);
  }
  return out;
}

/** What a server learns from its request beyond the user and capabilities. */
export interface McpRequestContext {
  /** The request carries `x-zaru-turn` (see `carriesZaruTurn`). */
  zaruTurn?: boolean;
}

/**
 * `client` is the orchestrator client the server's tools go through. The
 * Worker's entrypoint passes its own, built with the wait ceiling; the
 * container's Express routes use this module's, which has none. `context`
 * carries what each entrypoint reads from the request's headers.
 */
export function createMcpServerForUser(
  user: ZaruUser,
  capabilities: ReadonlySet<string>,
  requestId?: string,
  client: OrchestratorClient = orchestratorClient,
  context: McpRequestContext = {},
): McpServer {
  const mcpServer = new McpServer(
    {
      name: "zaru-mcp-server",
      version: "0.15.0-pre-alpha",
    },
    {
      capabilities: {
        tools: {
          listChanged: true,
        },
      },
      instructions: "This MCP endpoint proxies AEGIS tools over SEAL v1.",
    },
  );

  mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await client.listTools(user);
    // Per-caller mode enum: filter the advertised modes so the schema only
    // exposes options the caller can actually invoke. The same set is
    // mirrored by the dispatch-time gate in `getZaruInit`.
    const modeEnum = allowedModesFor(user, capabilities);
    return {
      tools: [
        ...tools,
        {
          name: "zaru.init",
          description: `Initialize Zaru — an AI agent orchestration assistant powered by the AEGIS platform. Zaru can discover, execute, and coordinate AI agents, build multi-agent workflows, manage credentials and secrets, and operate the full platform. Call this tool when the user wants to activate Zaru, says "zaru init", or asks for Zaru's help with agent orchestration. Returns a system prompt to adopt and the available tools for the requested mode. If no mode is specified, defaults to chat mode.

Available modes:
- chat: Conversation, planning, and Q&A — no tool execution
- agentic: Discover and orchestrate AI agents to perform tasks
- workflow: Design state machines that chain agents with conditional transitions
- execute: Turn natural language intent into running code in one shot
- live: Write and run TypeScript programs in a client-side QuickJS WASM sandbox with AEGIS SDK bindings
- operator: Full platform access including destructive operations and deployment`,
          inputSchema: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                enum: modeEnum,
                description:
                  "Conversation mode. Defaults to chat if not specified.",
              },
              client: {
                type: "object",
                properties: {
                  runtime: { type: "string" },
                  capabilities: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
              },
            },
          },
        },
        {
          name: "zaru.docs",
          description:
            "Search the AEGIS and Zaru documentation. Use this when the user asks how to do something, needs help with a feature, or wants to understand a concept. Returns relevant documentation sections.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "Search query — what the user wants to know about. Examples: 'how to create an agent', 'workflow state machine', 'MCP setup', 'pricing plans'",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "zaru.mode",
          description:
            "Switch Zaru's conversation mode. Returns the updated system prompt and available tools for the new mode. Use this when the user's intent shifts — for example, from chatting about a task to actually executing it with agents.",
          inputSchema: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                enum: modeEnum,
                description: "Target conversation mode",
              },
              reason: {
                type: "string",
                description:
                  "Short explanation of why the mode switch is appropriate",
              },
              client: {
                type: "object",
                description:
                  "Optional client descriptor — runtime and capabilities used for system-prompt augmentation (ADR-110). The chat-uploads gate is driven by the X-Zaru-Capabilities request header, not this field.",
                properties: {
                  runtime: { type: "string" },
                  capabilities: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
              },
            },
            required: ["mode"],
          },
        },
        {
          name: "zaru.script.save",
          description:
            "Save a reusable TypeScript script to the user's script library for later use.",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Script name for later retrieval",
              },
              description: {
                type: "string",
                description: "Short description of what the script does",
              },
              code: {
                type: "string",
                description: "TypeScript source code to save",
              },
            },
            required: ["name", "description", "code"],
          },
        },
        {
          name: "zaru.script.run",
          description: "Load and execute a previously saved script by name.",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Name of the saved script to run",
              },
              input: {
                type: "object",
                description: "Optional input parameters to pass to the script",
              },
            },
            required: ["name"],
          },
        },
        {
          name: "zaru.memory.get",
          description:
            "Fetch the current Zaru User Memory for this user — a single per-user markdown blob describing their preferences, working style, recurring projects, and other signals that make future conversations more useful. Returns { content, version, updated_at }. Always call this before zaru.memory.set so you have the current version for optimistic concurrency.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "zaru.memory.set",
          description:
            "Replace the Zaru User Memory for this user with a new full markdown blob. The `version` argument is MANDATORY and must equal the version returned by the most recent zaru.memory.get — this is optimistic concurrency control. On a version conflict, the tool returns the server's current { content, version, updated_at } so you can re-read, merge your update into the latest content, and retry. Always merge thoughtfully rather than overwriting wholesale; keep memory concise and signal-rich, not a transcript log.",
          inputSchema: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description:
                  "The full new memory document as markdown. This replaces the entire prior content — merge any prior content you want to keep into this string before sending.",
              },
              version: {
                type: "number",
                description:
                  "Version returned by the most recent zaru.memory.get. Required for optimistic concurrency. On mismatch the call returns a structured conflict error with the server's current state.",
              },
            },
            required: ["content", "version"],
          },
        },
        ZARU_CHAT_TOOL,
        // Zaru ADR-0050 D3 and D4: escalate to every API-key caller; release
        // only while the presented key holds an escalation.
        ...(isApiKey(user.token) ? [ZARU_OPERATOR_ESCALATE_TOOL] : []),
        ...(user.operatorEscalation ? [ZARU_OPERATOR_RELEASE_TOOL] : []),
      ],
    };
  });

  mcpServer.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Handle client-side tools locally — never forward to AEGIS.
    //
    // Note: `zaru.init` and `zaru.mode` historically recorded the client's
    // declared capabilities into per-session server state to drive the
    // ADR-113 chat-uploads gate. That design was wrong on two axes — see
    // `parseCapabilitiesHeader` and the commit message for the full
    // rationale. The capability is a property of the client and is now
    // sourced from the `X-Zaru-Capabilities` HTTP header on every request.
    // The `client.capabilities` array on these tools remains in use by
    // `getZaruInit()` for system-prompt augmentation per ADR-110.
    if (name === "zaru.init") {
      const mode = (args as Record<string, unknown>)?.mode as
        | string
        | undefined;
      const client = (args as Record<string, unknown>)?.client as
        | { runtime?: string; capabilities?: unknown }
        | undefined;
      const merged = resolveCapabilities(capabilities, client?.capabilities);
      const result = getZaruInit(mode, merged, client?.runtime, user);
      if (!result) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "Unknown mode" }) },
          ],
          isError: true,
        };
      }
      const withMemory = await injectMemoryIntoInit(zaruClient, user, result);
      return normalizeToolResult(withMemory);
    }

    if (name === "zaru.docs") {
      const query = (args as Record<string, unknown>)?.query as string;
      if (!query) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Query is required" }),
            },
          ],
          isError: true,
        };
      }
      try {
        const result = await searchDocs(query);
        return normalizeToolResult(result);
      } catch (err) {
        logError("zaru.docs.failed", {
          error: err instanceof Error ? err : { message: String(err) },
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Failed to search docs" }),
            },
          ],
          isError: true,
        };
      }
    }

    if (name === "zaru.mode") {
      const targetMode = (args as Record<string, unknown>)?.mode as string;
      const reason = (args as Record<string, unknown>)?.reason as
        | string
        | undefined;
      const client = (args as Record<string, unknown>)?.client as
        | { runtime?: string; capabilities?: unknown }
        | undefined;
      const merged = resolveCapabilities(capabilities, client?.capabilities);
      const result = getZaruInit(targetMode, merged, client?.runtime, user);
      if (!result) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "Unknown mode" }) },
          ],
          isError: true,
        };
      }
      const withMemory = await injectMemoryIntoInit(zaruClient, user, result);
      return normalizeToolResult({
        ...withMemory,
        reason,
        action: "mode_switch_requested",
      });
    }

    if (name === "zaru.execute_typescript") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error:
                "execute_typescript is a client-side tool and must be handled by the client, not the MCP server.",
            }),
          },
        ],
        isError: true,
      };
    }

    if (name === "zaru.script.save" || name === "zaru.script.run") {
      return handleZaruScriptTool(
        client,
        user,
        name,
        args,
        requestId,
      );
    }

    if (name === "zaru.memory.get") {
      return handleZaruMemoryGet(zaruClient, user);
    }

    if (name === "zaru.memory.set") {
      return handleZaruMemorySet(zaruClient, user, args);
    }

    if (name === ZARU_CHAT_TOOL.name) {
      return handleZaruChat(zaruClient, user, args, context.zaruTurn === true);
    }

    if (name === "zaru.operator.escalate") {
      return handleOperatorEscalate(client, user, args);
    }

    if (name === "zaru.operator.release") {
      return handleOperatorRelease(client, user);
    }

    // ADR-113 defence-in-depth: reject `attachments` from any client that has
    // not declared the "chat-uploads" capability via the X-Zaru-Capabilities
    // request header. The orchestrator and the Zaru web client also gate
    // this — the MCP server must not silently forward attachments from a
    // non-capable client.
    if (shouldRejectAttachments(name, args, capabilities)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error:
                "attachments are only accepted from clients that declare the 'chat-uploads' capability via the X-Zaru-Capabilities request header.",
            }),
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await client.invokeTool(
        user,
        name,
        (args as Record<string, unknown>) ?? {},
        null,
        { requestId },
      );
      return normalizeToolResult(result);
    } catch (error) {
      logError("tool.dispatch.failed", {
        tool_name: name,
        error: error instanceof Error ? error : { message: String(error) },
      });
      throw error;
    }
  });

  return mcpServer;
}

/**
 * POST /mcp/v1 - Handle StreamableHTTP requests.
 *
 * Stateless mode: every HTTP request gets a fresh transport and `McpServer`.
 * The server holds no per-session state — restart-survival is therefore
 * trivial. Client capability declarations (ADR-113 chat-uploads gate) are
 * read from the `X-Zaru-Capabilities` request header on every call, NOT
 * stored server-side. See `parseCapabilitiesHeader`.
 */
export async function handleStreamableHttp(
  req: ZaruRequest,
  res: Response,
): Promise<void> {
  const user = req.zaruUser;
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const capabilities = parseCapabilitiesHeader(
    req.headers["x-zaru-capabilities"],
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  const server = createMcpServerForUser(
    user,
    capabilities,
    req.requestId,
    orchestratorClient,
    { zaruTurn: carriesZaruTurn(req.headers[ZARU_TURN_HEADER]) },
  );
  await server.connect(transport);

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await transport.handleRequest(req, res, req.body);
}

/**
 * GET /mcp/v1 - Server-initiated notifications via SSE (per StreamableHTTP spec).
 *
 * Stateless mode does not support server-initiated push, so return 405.
 */
export async function handleStreamableHttpGet(
  _req: ZaruRequest,
  res: Response,
): Promise<void> {
  res
    .status(405)
    .json({ error: "Method Not Allowed: server-initiated push not supported" });
}

/**
 * DELETE /mcp/v1 - Session cleanup.
 *
 * Stateless mode holds no session state, so DELETE is a no-op.
 */
export async function handleStreamableHttpDelete(
  _req: ZaruRequest,
  res: Response,
): Promise<void> {
  res.status(200).json({ status: "ok" });
}
