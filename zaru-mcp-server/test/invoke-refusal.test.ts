// What the Zaru MCP server tells its caller when the orchestrator refuses or
// fails a tool call (AEGIS ADR-035, Update R1 to R8, adrs/035-updates at
// revision 43571; `aegis-orchestrator` 0c60875b, `cli/src/daemon/handlers/
// seal.rs` 606-667 and `orchestrator/core/src/domain/seal_session.rs`
// 300-400). The orchestrator answers every refusal of `POST /v1/seal/invoke`
// as {protocol, request_id, status, error: {code, message, context, tool}}.
// The server relays a caller-facing refusal's code and message, tells an
// internal failure by its fixed sentence, and tells anything it does not
// trust as `invoke_failed`: always as a tool result with isError true, never
// as a JSON-RPC error.

import test from "node:test";
import assert from "node:assert/strict";
import {
  OrchestratorClient,
  SESSION_NOT_RENEWED_MESSAGE,
} from "../src/mcp/orchestrator-client.js";
import { handleZaruScriptTool } from "../src/mcp/streamable-http.js";

const REQUEST_ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const USER = {
  userId: "user-refusal-relay",
  tier: "free",
  securityContext: "zaru-free",
  token: "jwt",
  isOperator: false,
};

/** An ADR-035 refusal body as `invoke_refusal_response` builds it. */
function adr035(
  code: string,
  message: string,
  status: "policy_violation" | "error" = "error",
  requestId: unknown = REQUEST_ID,
): Record<string, unknown> {
  return {
    protocol: "seal/v1",
    request_id: requestId,
    status,
    error: { code, message, context: null, tool: "aegis.task.list" },
  };
}

function answer(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): () => Response {
  return () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
}

/** A client whose invoke answers `answers` in turn (the last repeats). */
function harness(answers: Array<() => Response>) {
  const counts = { attest: 0, invoke: 0 };
  const client = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/seal/attest")) {
        counts.attest++;
        return new Response(
          JSON.stringify({ security_token: `token-${counts.attest}` }),
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/seal/invoke")) {
        const next = answers[Math.min(counts.invoke, answers.length - 1)];
        counts.invoke++;
        return next();
      }
      return new Response("{}", { status: 404 });
    },
  });
  return { client, counts };
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

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
};

/** One tools/call through invokeTool against one orchestrator answer. */
async function callWith(
  first: () => Response,
): Promise<{ result: ToolResult; text: string; logs: Array<Record<string, unknown>>; counts: { attest: number; invoke: number } }> {
  const { client, counts } = harness([first]);
  const { value, logs } = await withLogs(() =>
    client.invokeTool(USER, "aegis.task.list", {}, 7, { requestId: "req-1" }),
  );
  const result = value as ToolResult;
  assert.equal(result.isError, true, "a refusal is a tool result with isError true");
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]!.type, "text");
  return { result, text: result.content[0]!.text, logs, counts };
}

function endLog(logs: Array<Record<string, unknown>>): Record<string, unknown> {
  const end = logs.filter((l) => l.event === "tool.invoke.end");
  assert.equal(end.length, 1, "one tool.invoke.end line");
  return end[0]!;
}

// ── Caller-facing refusals: code and message relayed ──────────────────────

test("relay: a 403 TOOL_NOT_ALLOWED is a tool result carrying the orchestrator's code, message and request_id", async () => {
  const message =
    "Policy violation: tool 'aegis.task.list' is not allowed; permitted tools: [zaru.*]";
  const { text, counts } = await callWith(
    answer(adr035("TOOL_NOT_ALLOWED", message, "policy_violation"), 403),
  );
  assert.deepEqual(JSON.parse(text), {
    error: { code: "TOOL_NOT_ALLOWED", message },
    request_id: REQUEST_ID,
  });
  assert.equal(counts.attest, 1, "a refusal is not re-attested");
  assert.equal(counts.invoke, 1);
});

test("relay: every caller-facing row of R5 below 500 but 401, and 501 and 503 EDGE_UNAVAILABLE, is relayed at its own status", async () => {
  const rows: Array<[string, number, "policy_violation" | "error"]> = [
    ["MALFORMED_ENVELOPE", 400, "error"],
    ["TOOL_DENIED", 403, "policy_violation"],
    ["PATH_NOT_ALLOWED", 403, "policy_violation"],
    ["PATH_TRAVERSAL", 403, "policy_violation"],
    ["DOMAIN_NOT_ALLOWED", 403, "policy_violation"],
    ["COMMAND_NOT_ALLOWED", 403, "policy_violation"],
    ["SUBCOMMAND_NOT_ALLOWED", 403, "policy_violation"],
    ["POLICY_ARGUMENT_REQUIRED", 403, "policy_violation"],
    ["LIMIT_EXCEEDED", 403, "policy_violation"],
    ["JUDGE_REJECTED", 403, "policy_violation"],
    ["TENANT_MISMATCH", 403, "error"],
    ["NOT_FOUND", 404, "error"],
    ["CONFLICT", 409, "error"],
    ["INVALID_ARGUMENTS", 422, "error"],
    ["QUOTA_EXCEEDED", 422, "error"],
    ["NOT_IMPLEMENTED", 501, "error"],
    ["EDGE_UNAVAILABLE", 503, "error"],
  ];
  for (const [code, status, member] of rows) {
    const message = `the caller's own business for ${code}`;
    const { text } = await callWith(answer(adr035(code, message, member), status));
    assert.deepEqual(
      JSON.parse(text),
      { error: { code, message }, request_id: REQUEST_ID },
      `${code} at ${status}`,
    );
  }
});

test("relay: a 429 RATE_LIMIT_EXCEEDED carries retry_after_seconds from Retry-After", async () => {
  const message =
    "Policy violation: rate limit exceeded for tool_call/per_minute: 61/60, retry after 17s";
  const { text } = await callWith(
    answer(adr035("RATE_LIMIT_EXCEEDED", message, "policy_violation"), 429, {
      "Retry-After": "17",
      "X-RateLimit-Limit": "60",
      "X-RateLimit-Remaining": "0",
    }),
  );
  assert.deepEqual(JSON.parse(text), {
    error: { code: "RATE_LIMIT_EXCEEDED", message },
    request_id: REQUEST_ID,
    retry_after_seconds: 17,
  });
});

// ── Internal failures: the server's own sentence ──────────────────────────

test("relay: 500, 502 and 503 SERVICE_UNAVAILABLE are told by their fixed sentence, never the body's message", async () => {
  const detail =
    "Internal error: Database error: relation \"tenants\" does not exist at /var/lib/aegis/volumes/7/workspace (spec.iam.keycloak_admin)";
  const rows: Array<[string, number, string]> = [
    [
      "INTERNAL_ERROR",
      500,
      "The request could not be completed because of an internal error.",
    ],
    [
      "UPSTREAM_UNAVAILABLE",
      502,
      "A service this tool depends on did not answer. Try again in a moment.",
    ],
    ["SERVICE_UNAVAILABLE", 503, "This tool is not available right now."],
  ];
  for (const [code, status, sentence] of rows) {
    const { text } = await callWith(answer(adr035(code, detail), status));
    assert.deepEqual(
      JSON.parse(text),
      { error: { code, message: sentence }, request_id: REQUEST_ID },
      `${code} at ${status}`,
    );
    assert.doesNotMatch(text, /Database|tenants|volumes|keycloak/);
  }
});

// ── Anything the relay does not trust: invoke_failed ──────────────────────

test("relay: a body outside ADR-035's shape is never relayed, whatever its status", async () => {
  const leaky = {
    error:
      "Internal error: Database error: relation \"tenants\" does not exist; backend path /aegis/volumes/0b6c/workspace/notes.md",
  };
  for (const status of [400, 403, 404, 422, 500, 502, 503]) {
    for (const body of [leaky, leaky.error, "<html>502 Bad Gateway</html>"]) {
      const { text } = await callWith(answer(body, status));
      assert.deepEqual(
        JSON.parse(text),
        {
          error: {
            code: "invoke_failed",
            message: `AEGIS invoke failed: ${status}`,
          },
        },
        `status ${status}, body ${JSON.stringify(body)}`,
      );
    }
  }
});

test("relay: a shaped body with a code R5 does not list, or a listed code at another status, is invoke_failed with its request_id", async () => {
  const cases: Array<[Record<string, unknown>, number]> = [
    [adr035("SOMETHING_NEW", "Internal error: /aegis/volumes/x"), 400],
    [adr035("TOOL_NOT_ALLOWED", "Internal error: /aegis/volumes/x"), 400],
    [adr035("NOT_FOUND", "Internal error: /aegis/volumes/x"), 500],
    [adr035("EDGE_UNAVAILABLE", "Internal error: /aegis/volumes/x"), 500],
    [adr035("INTERNAL_ERROR", "Internal error: /aegis/volumes/x"), 403],
  ];
  for (const [body, status] of cases) {
    const { text } = await callWith(answer(body, status));
    assert.deepEqual(
      JSON.parse(text),
      {
        error: { code: "invoke_failed", message: `AEGIS invoke failed: ${status}` },
        request_id: REQUEST_ID,
      },
      `${JSON.stringify(body)} at ${status}`,
    );
  }
});

test("relay: a request_id that is not a UUID is not echoed, and the body is then untrusted", async () => {
  const { text } = await callWith(
    answer(
      adr035(
        "TOOL_NOT_ALLOWED",
        "Policy violation: tool 'x' is not allowed; permitted tools: []",
        "policy_violation",
        "req-123 /aegis/volumes/7",
      ),
      403,
    ),
  );
  assert.deepEqual(JSON.parse(text), {
    error: { code: "invoke_failed", message: "AEGIS invoke failed: 403" },
  });
});

test("relay: a body missing protocol, status or error.message is untrusted", async () => {
  const good = adr035("NOT_FOUND", "Not found: tool 'aegis.x'.");
  const broken: Array<Record<string, unknown>> = [
    { ...good, protocol: "seal/v2" },
    { ...good, status: "denied" },
    { ...good, error: { code: "NOT_FOUND" } },
    { ...good, error: "Not found: tool 'aegis.x'." },
  ];
  for (const body of broken) {
    const { text } = await callWith(answer(body, 404));
    assert.equal(
      (JSON.parse(text) as { error: { code: string } }).error.code,
      "invoke_failed",
      JSON.stringify(body),
    );
    assert.doesNotMatch(text, /aegis\.x/);
  }
});

// ── A 401 that survives the one re-attest (q3) ────────────────────────────

test("relay: a 401 after the one re-attest and retry is told the code and the server's own sentence; the orchestrator's goes to the log", async () => {
  for (const [code, message] of [
    ["SESSION_INACTIVE", "Your session is no longer active. Attest again to start a new one."],
    ["SIGNATURE_INVALID", "The request's signature or security token did not verify. Attest again to start a new session."],
    ["OPERATOR_ESCALATION_EXPIRED", "Your operator escalation has ended."],
  ] as const) {
    const { text, logs, counts } = await callWith(
      answer(adr035(code, message), 401),
    );
    assert.equal(counts.attest, 2, "re-attested once");
    assert.equal(counts.invoke, 2, "retried once");
    assert.deepEqual(JSON.parse(text), {
      error: { code, message: SESSION_NOT_RENEWED_MESSAGE },
      request_id: REQUEST_ID,
    });
    assert.doesNotMatch(text, /Attest again/);
    const end = endLog(logs);
    assert.equal(end.level, "warn");
    assert.equal(end.status, "session_not_renewed");
    assert.equal(end.upstream_message, message);
    assert.equal(end.upstream_request_id, REQUEST_ID);
  }
});

// ── What the server logs ──────────────────────────────────────────────────

test("log: a 403 policy refusal is policy_denied at info, with the code and request_id", async () => {
  const { logs } = await callWith(
    answer(
      adr035("TOOL_NOT_ALLOWED", "Policy violation: tool 'x' is not allowed; permitted tools: []", "policy_violation"),
      403,
    ),
  );
  const end = endLog(logs);
  assert.equal(end.level, "info");
  assert.equal(end.status, "policy_denied");
  assert.equal(end.upstream_status, 403);
  assert.equal(end.upstream_code, "TOOL_NOT_ALLOWED");
  assert.equal(end.upstream_request_id, REQUEST_ID);
});

test("log: a caller-facing refusal that is not a policy violation is refused at info", async () => {
  const { logs } = await callWith(
    answer(adr035("NOT_FOUND", "Not found: tool 'aegis.x'."), 404),
  );
  const end = endLog(logs);
  assert.equal(end.level, "info");
  assert.equal(end.status, "refused");
});

test("log: an internal failure and an untrusted body are upstream_error at error, with the whole body", async () => {
  const internal = adr035("INTERNAL_ERROR", "Internal error: Database error: x");
  for (const [body, status] of [
    [internal, 500],
    [{ error: "Database error: x" }, 400],
  ] as const) {
    const { logs } = await callWith(answer(body, status));
    const end = endLog(logs);
    assert.equal(end.level, "error");
    assert.equal(end.status, "upstream_error");
    assert.deepEqual(end.upstream_body, body);
  }
});

// ── What does not change ──────────────────────────────────────────────────

test("unchanged: a successful call answers the orchestrator's result as before", async () => {
  const { client } = harness([
    answer(
      {
        jsonrpc: "2.0",
        id: 7,
        result: { content: [{ type: "text", text: "[]" }], isError: false },
      },
      200,
    ),
  ]);
  const result = await client.invokeTool(USER, "aegis.task.list", {}, 7);
  assert.deepEqual(result, {
    content: [{ type: "text", text: "[]" }],
    isError: false,
  });
});

test("unchanged: an orchestrator that cannot be reached still throws", async () => {
  const client = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    fetchImpl: async (input) => {
      if (String(input).endsWith("/v1/seal/attest")) {
        return new Response(JSON.stringify({ security_token: "t" }), {
          status: 200,
        });
      }
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(
    () => client.invokeTool(USER, "aegis.task.list", {}, 7),
    /fetch failed/,
  );
});

test("unchanged: the escalation's own refusal (Zaru ADR-0050 U1) is relayed exactly as the orchestrator sent it", async () => {
  const refusal = {
    error: "code_expired",
    message: "the code has expired",
  };
  const client = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    fetchImpl: async () =>
      new Response(JSON.stringify(refusal), { status: 400 }),
  });
  assert.deepEqual(await client.redeemOperatorEscalation(USER, "123456"), {
    ok: false,
    refusal,
  });
});

// ── zaru.script.run does not read a refusal as an empty list ──────────────

test("zaru.script.run: a refused aegis.script.list is returned as the refusal, not 'No saved script named'", async () => {
  const message =
    "Policy violation: tool 'aegis.script.list' is not allowed; permitted tools: [zaru.*]";
  const { client } = harness([
    answer(adr035("TOOL_NOT_ALLOWED", message, "policy_violation"), 403),
  ]);
  const result = await withLogs(() =>
    handleZaruScriptTool(client, USER, "zaru.script.run", { name: "hello" }),
  );
  assert.equal(result.value.isError, true);
  assert.deepEqual(JSON.parse(result.value.content[0]!.text), {
    error: { code: "TOOL_NOT_ALLOWED", message },
    request_id: REQUEST_ID,
  });
});
