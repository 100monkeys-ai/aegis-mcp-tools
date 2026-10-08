// The relay's table of the orchestrator's refusal codes, pinned row by row
// against AEGIS ADR-035's R5 table (adrs/035-updates at revision 47945: the
// Update of 2026-10-04 R5, the Update of 2026-10-05 "four R5 rows for the
// SEAL gateway's refusals", A3's CONTEXT_NOT_ALLOWED row and the Update of
// 2026-10-08 U1, under which UPSTREAM_UNAVAILABLE is answered 503 with
// `Retry-After: 5` because Cloudflare's proxy replaces an origin 502's body),
// and the production report that found a row missing.
//
// The report (2026-10-08, about 17:14Z): Zaru Web called the Nuclear Notes
// tool `nuclear-notes.pages.read` with `section` "K11"; the remote server
// refused it, the orchestrator answered 422 REMOTE_TOOL_ERROR with the
// server's own sentence (`aegis-orchestrator` 9907ce69,
// `orchestrator/core/src/domain/seal_session.rs` 450-452), and this server,
// whose table had no such row, told the person "AEGIS invoke failed: 422"
// (`invoke_failed`, Zaru ADR-0050 E1's rule for an answer it does not trust).
//
// ADR_035_R5 below is ADR-035's table transcribed: a row added to the record
// is added here, and the second test fails until the relay has it too.

import test from "node:test";
import assert from "node:assert/strict";
import * as orchestratorClient from "../src/mcp/orchestrator-client.js";
import {
  OrchestratorClient,
  SESSION_NOT_RENEWED_MESSAGE,
  relayFailure,
} from "../src/mcp/orchestrator-client.js";

const REQUEST_ID = "217877e3-8179-4c5a-b7a9-e6c0ee8c511b";

type Member = "policy_violation" | "error";

/**
 * One row of ADR-035's R5 table: the code, its HTTP status, the body's
 * `status` member, and whether it is an internal class (told by its fixed
 * sentence, R4) or a caller-facing refusal (its message relayed, R3).
 */
interface R5Row {
  code: string;
  status: number;
  member: Member;
  internal: boolean;
  /** An internal class's fixed sentence, as the table gives it. */
  sentence?: string;
}

const NOT_AVAILABLE = "This tool is not available right now.";

const ADR_035_R5: readonly R5Row[] = [
  // The Update of 2026-10-04, R5.
  { code: "MALFORMED_ENVELOPE", status: 400, member: "error", internal: false },
  { code: "SIGNATURE_INVALID", status: 401, member: "error", internal: false },
  { code: "ENVELOPE_REPLAYED", status: 401, member: "error", internal: false },
  { code: "SESSION_INACTIVE", status: 401, member: "error", internal: false },
  { code: "SESSION_EXPIRED", status: 401, member: "error", internal: false },
  { code: "OPERATOR_ESCALATION_EXPIRED", status: 401, member: "error", internal: false },
  { code: "TOOL_NOT_ALLOWED", status: 403, member: "policy_violation", internal: false },
  { code: "TOOL_DENIED", status: 403, member: "policy_violation", internal: false },
  { code: "PATH_NOT_ALLOWED", status: 403, member: "policy_violation", internal: false },
  { code: "PATH_TRAVERSAL", status: 403, member: "policy_violation", internal: false },
  { code: "DOMAIN_NOT_ALLOWED", status: 403, member: "policy_violation", internal: false },
  { code: "COMMAND_NOT_ALLOWED", status: 403, member: "policy_violation", internal: false },
  { code: "SUBCOMMAND_NOT_ALLOWED", status: 403, member: "policy_violation", internal: false },
  { code: "POLICY_ARGUMENT_REQUIRED", status: 403, member: "policy_violation", internal: false },
  { code: "LIMIT_EXCEEDED", status: 403, member: "policy_violation", internal: false },
  { code: "RATE_LIMIT_EXCEEDED", status: 429, member: "policy_violation", internal: false },
  { code: "JUDGE_REJECTED", status: 403, member: "policy_violation", internal: false },
  { code: "TENANT_MISMATCH", status: 403, member: "error", internal: false },
  { code: "INVALID_ARGUMENTS", status: 422, member: "error", internal: false },
  { code: "QUOTA_EXCEEDED", status: 422, member: "error", internal: false },
  { code: "NOT_FOUND", status: 404, member: "error", internal: false },
  { code: "CONFLICT", status: 409, member: "error", internal: false },
  { code: "NOT_IMPLEMENTED", status: 501, member: "error", internal: false },
  { code: "EDGE_UNAVAILABLE", status: 503, member: "error", internal: false },
  {
    code: "INTERNAL_ERROR",
    status: 500,
    member: "error",
    internal: true,
    sentence: "The request could not be completed because of an internal error.",
  },
  {
    code: "UPSTREAM_UNAVAILABLE",
    // U1 (2026-10-08): 502 until then.
    status: 503,
    member: "error",
    internal: true,
    sentence: "A service this tool depends on did not answer. Try again in a moment.",
  },
  {
    code: "SERVICE_UNAVAILABLE",
    status: 503,
    member: "error",
    internal: true,
    sentence: NOT_AVAILABLE,
  },
  // The Update of 2026-10-05: the SEAL gateway's refusals.
  { code: "CREDENTIAL_BINDING_REQUIRED", status: 403, member: "policy_violation", internal: false },
  { code: "CREDENTIAL_REJECTED", status: 403, member: "error", internal: false },
  { code: "REMOTE_TOOL_ERROR", status: 422, member: "error", internal: false },
  {
    code: "CREDENTIAL_CHANNEL_NOT_CONFIDENTIAL",
    status: 503,
    member: "error",
    internal: true,
    sentence: NOT_AVAILABLE,
  },
  // The Update of 2026-10-05, A3: the attest route's refusal.
  { code: "CONTEXT_NOT_ALLOWED", status: 403, member: "policy_violation", internal: false },
];

const USER = {
  userId: "user-r5-table",
  tier: "free",
  securityContext: "zaru-free",
  token: "jwt",
  isOperator: false,
};

function shaped(code: string, message: string, member: Member) {
  return {
    protocol: "seal/v1",
    request_id: REQUEST_ID,
    status: member,
    error: { code, message, context: null, tool: "nuclear-notes.pages.read" },
  };
}

/** Run `fn`, returning its value and every log record written meanwhile. */
async function withLogs<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; logs: Array<Record<string, unknown>> }> {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  (process.stdout.write as unknown) = (chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const value = await fn();
    return {
      value,
      logs: chunks
        .join("")
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    };
  } finally {
    process.stdout.write = original;
  }
}

// ── The report, as the person met it ──────────────────────────────────────

test("report: a remote server's refusal (422 REMOTE_TOOL_ERROR) reaches the caller as its code and the server's own sentence, not 'AEGIS invoke failed: 422'", async () => {
  // The server's sentence is illustrative: the report shows only what this
  // server made of it. It passes through unchanged, whatever it says.
  const message = "No heading named \"K11\" on the page.";
  const counts = { attest: 0, invoke: 0 };
  const client = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/seal/attest")) {
        counts.attest++;
        return new Response(JSON.stringify({ security_token: "token" }), {
          status: 200,
        });
      }
      if (url.endsWith("/v1/seal/invoke")) {
        counts.invoke++;
        return new Response(
          JSON.stringify(shaped("REMOTE_TOOL_ERROR", message, "error")),
          { status: 422, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    },
  });
  const { value, logs } = await withLogs(() =>
    client.invokeTool(
      USER,
      "nuclear-notes.pages.read",
      { pathOrId: "adrs/138-calendar-connections", section: "K11" },
      7,
      { requestId: "req-k11" },
    ),
  );
  const result = value as {
    content: Array<{ type: string; text: string }>;
    isError: boolean;
  };
  assert.equal(result.isError, true, "a refusal is a tool result with isError true");
  assert.equal(result.content.length, 1);
  assert.deepEqual(
    JSON.parse(result.content[0]!.text),
    {
      error: { code: "REMOTE_TOOL_ERROR", message },
      request_id: REQUEST_ID,
    },
    "a 422 REMOTE_TOOL_ERROR is relayed with its code and the server's sentence",
  );
  assert.equal(counts.attest, 1, "a refusal is not re-attested");
  assert.equal(counts.invoke, 1, "a refusal is not retried");
  const end = logs.filter((l) => l.event === "tool.invoke.end");
  assert.equal(end.length, 1, "one tool.invoke.end line");
  assert.equal(end[0]!.level, "info", "a caller-facing refusal is logged at info");
  assert.equal(end[0]!.status, "refused");
  assert.equal(end[0]!.upstream_code, "REMOTE_TOOL_ERROR");
});

// ── The table, row by row ─────────────────────────────────────────────────

test("table: every row of ADR-035's R5 table is relayed at its own status as its kind says", () => {
  const wrong: string[] = [];
  for (const row of ADR_035_R5) {
    const message = `the answer's own words for ${row.code}`;
    const relayed = relayFailure(
      "invoke",
      row.status,
      shaped(row.code, message, row.member),
      row.status === 429 ? "17" : null,
    );
    const expected = row.internal
      ? { kind: "internal", code: row.code, message: row.sentence }
      : row.status === 401
        ? { kind: "session", code: row.code, message: SESSION_NOT_RENEWED_MESSAGE }
        : { kind: "refused", code: row.code, message };
    const got = { kind: relayed.kind, code: relayed.code, message: relayed.message };
    try {
      assert.deepEqual(got, expected);
    } catch {
      wrong.push(
        `  ${row.code} at ${row.status}: relayed ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`,
      );
    }
    if (!row.internal && row.status !== 401) {
      const policy = row.member === "policy_violation";
      if (relayed.kind === "refused" && relayed.policy !== policy) {
        wrong.push(`  ${row.code} at ${row.status}: policy ${relayed.policy}, expected ${policy}`);
      }
    }
  }
  // Every row is checked before failing once, so one red names them all.
  if (wrong.length > 0) {
    assert.fail(
      `${wrong.length} row(s) of ADR-035's R5 table are not relayed as the table says:\n${wrong.join("\n")}`,
    );
  }
});

test("table: the relay's table holds exactly ADR-035's R5 rows, each with the table's status and kind, and no other", () => {
  const relayTable = (orchestratorClient as Record<string, unknown>).R5_ROWS as
    | Record<string, { status: number; internal: boolean }>
    | undefined;
  assert.ok(relayTable, "the relay's table is exported as R5_ROWS");
  const expected = Object.fromEntries(
    ADR_035_R5.map((row) => [row.code, { status: row.status, internal: row.internal }]),
  );
  const missing = Object.keys(expected).filter((code) => !(code in relayTable));
  const extra = Object.keys(relayTable).filter((code) => !(code in expected));
  const differing = Object.keys(expected)
    .filter((code) => code in relayTable)
    .filter(
      (code) =>
        relayTable[code]!.status !== expected[code]!.status ||
        relayTable[code]!.internal !== expected[code]!.internal,
    );
  assert.deepEqual(
    { missing, extra, differing },
    { missing: [], extra: [], differing: [] },
    "the relay's table and ADR-035's R5 table differ",
  );
});

test("table: a code the table does not list, or a listed code at another status, is still not trusted", () => {
  for (const [code, status] of [
    ["SOMETHING_NEW", 422],
    ["REMOTE_TOOL_ERROR", 400],
    ["REMOTE_TOOL_ERROR", 500],
    ["CREDENTIAL_REJECTED", 401],
    ["CREDENTIAL_CHANNEL_NOT_CONFIDENTIAL", 500],
    // U1: the row's status before 2026-10-08, now another status.
    ["UPSTREAM_UNAVAILABLE", 502],
  ] as const) {
    const relayed = relayFailure("invoke", status, shaped(code, "Internal error: /aegis/volumes/x", "error"));
    assert.deepEqual(
      { kind: relayed.kind, code: relayed.code, message: relayed.message },
      { kind: "generic", code: "invoke_failed", message: `AEGIS invoke failed: ${status}` },
      `${code} at ${status}`,
    );
  }
});
