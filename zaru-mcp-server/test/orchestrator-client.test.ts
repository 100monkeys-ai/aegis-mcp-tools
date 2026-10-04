import test from "node:test";
import assert from "node:assert/strict";
import {
  InvalidExecutionIdError,
  OrchestratorClient,
  WAIT_CEILING_SECONDS,
} from "../src/mcp/orchestrator-client.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

test("listTools uses orchestrator discovery and caches by security context", async () => {
  const calls: Array<{
    method: string;
    url: string;
    headers?: Record<string, string>;
  }> = [];
  const client = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    toolDiscoveryUrl: "http://aegis.test/v1/seal/tools",
    cacheTtlMs: 60_000,
    fetchImpl: async (input, init) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(input),
        headers: init?.headers as Record<string, string> | undefined,
      });
      return jsonResponse({
        tools: [
          {
            name: "fs.read",
            description: "Read a file",
            inputSchema: { type: "object" },
          },
          {
            name: "aegis.task.logs",
            description: "Fetch task execution logs",
            inputSchema: {
              type: "object",
              properties: {
                execution_id: { type: "string" },
                limit: { type: "integer" },
                offset: { type: "integer" },
              },
              required: ["execution_id"],
            },
          },
        ],
      });
    },
  });

  const user = {
    userId: "user-1",
    tier: "free",
    securityContext: "zaru-free",
    token: "jwt",
    isOperator: false,
  };

  const first = await client.listTools(user);
  const second = await client.listTools(user);

  assert.equal(first[0]?.name, "fs.read");
  assert.equal(first[1]?.name, "aegis.task.logs");
  assert.equal(second[0]?.name, "fs.read");
  assert.equal(second[1]?.name, "aegis.task.logs");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    method: "GET",
    url: "http://aegis.test/v1/seal/tools",
    headers: {
      Accept: "application/json",
      "X-Zaru-Security-Context": "zaru-free",
    },
  });
});

test("streamExecution sends Keycloak JWT as Authorization Bearer and omits token query param", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const client = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(null, { status: 200 });
    },
  });

  const user = {
    userId: "user-3",
    tier: "pro",
    securityContext: "zaru-pro",
    token: "keycloak-jwt-xyz",
    isOperator: false,
  };

  await client.streamExecution(user, "3f2b8c1e-9d4a-4e6b-8a7f-0c1d2e3f4a5b");

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    "http://aegis.test/v1/executions/3f2b8c1e-9d4a-4e6b-8a7f-0c1d2e3f4a5b/events",
  );
  assert.ok(
    !calls[0]?.url.includes("?token="),
    "URL must not contain ?token= query param",
  );
  assert.equal(calls[0]?.headers["Authorization"], "Bearer keycloak-jwt-xyz");
});

test("streamExecution refuses a non-UUID execution id without calling fetch", async () => {
  let fetchCalls = 0;
  const client = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    fetchImpl: async () => {
      fetchCalls++;
      return new Response(null, { status: 200 });
    },
  });
  const user = {
    userId: "user-3",
    tier: "pro",
    securityContext: "zaru-pro",
    token: "keycloak-jwt-xyz",
    isOperator: false,
  };

  for (const id of [
    "exec-abc",
    "../../v1/credentials?",
    "..\\..\\v1\\credentials",
    "3f2b8c1e-9d4a-4e6b-8a7f-0c1d2e3f4a5b/../x",
    "3f2b8c1e-9d4a-4e6b-8a7f-0c1d2e3f4a5b#",
    "",
  ]) {
    await assert.rejects(
      () => client.streamExecution(user, id),
      InvalidExecutionIdError,
      `expected InvalidExecutionIdError for ${JSON.stringify(id)}`,
    );
  }
  assert.equal(fetchCalls, 0);
});

test("invokeTool attests and sends a spec-shaped SEAL envelope", async () => {
  const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const client = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    fetchImpl: async (input, init) => {
      const url = String(input);
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      calls.push({ url, body });

      if (url.endsWith("/v1/seal/attest")) {
        return jsonResponse({ security_token: "issued-token" });
      }

      if (url.endsWith("/v1/seal/invoke")) {
        return jsonResponse({
          jsonrpc: "2.0",
          id: "req-2",
          result: {
            content: [{ type: "text", text: "ok" }],
            isError: false,
          },
        });
      }

      return jsonResponse({}, 404);
    },
  });

  const user = {
    userId: "user-2",
    tier: "enterprise",
    securityContext: "zaru-enterprise",
    token: "jwt",
    isOperator: false,
  };

  const result = await client.invokeTool(
    user,
    "aegis.task.logs",
    { execution_id: "exec-123", limit: 50, offset: 0 },
    "req-2",
  );

  assert.deepEqual(result, {
    content: [{ type: "text", text: "ok" }],
    isError: false,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, "http://aegis.test/v1/seal/attest");
  assert.equal(calls[0]?.body?.user_id, undefined);
  assert.equal(
    calls[0]?.body?.workload_id?.toString().startsWith("zaru:user-2:"),
    true,
  );
  assert.equal(calls[0]?.body?.security_context, "zaru-enterprise");
  assert.equal(calls[0]?.body?.zaru_tier, "enterprise");
  assert.equal(calls[0]?.body?.agent_id, undefined);
  assert.equal(calls[0]?.body?.execution_id, undefined);
  // A Worker has no container on the orchestrator's runtime: sending a
  // container_id makes the orchestrator inspect it and refuse (401).
  assert.equal(calls[0]?.body?.container_id, undefined);
  assert.equal(typeof calls[0]?.body?.public_key, "string");
  assert.equal(calls[1]?.url, "http://aegis.test/v1/seal/invoke");
  assert.equal(calls[1]?.body?.protocol, "seal/v1");
  assert.equal(calls[1]?.body?.security_token, "issued-token");
  assert.equal(
    (calls[1]?.body?.payload as { method: string }).method,
    "tools/call",
  );
  assert.deepEqual((calls[1]?.body?.payload as { params: unknown }).params, {
    name: "aegis.task.logs",
    arguments: {
      execution_id: "exec-123",
      limit: 50,
      offset: 0,
    },
  });
  assert.equal(typeof calls[1]?.body?.timestamp, "string");
  assert.equal(typeof calls[1]?.body?.signature, "string");
});

test("invokeJsonRpc passes an AbortSignal with 330s timeout to fetchImpl for /v1/seal/invoke", async () => {
  const capturedSignals: Array<AbortSignal | undefined> = [];
  const client = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    fetchImpl: async (input, init) => {
      const url = String(input);

      if (url.endsWith("/v1/seal/attest")) {
        return jsonResponse({ security_token: "issued-token" });
      }

      if (url.endsWith("/v1/seal/invoke")) {
        capturedSignals.push(init?.signal as AbortSignal | undefined);
        return jsonResponse({
          jsonrpc: "2.0",
          id: "req-timeout",
          result: { content: [{ type: "text", text: "ok" }], isError: false },
        });
      }

      return jsonResponse({}, 404);
    },
  });

  const user = {
    userId: "user-timeout",
    tier: "free",
    securityContext: "zaru-free",
    token: "jwt",
    isOperator: false,
  };

  await client.invokeTool(
    user,
    "aegis.execute.wait",
    { execution_id: "exec-1" },
    "req-timeout",
  );

  assert.equal(
    capturedSignals.length,
    1,
    "fetchImpl should be called once for /v1/seal/invoke",
  );
  assert.ok(
    capturedSignals[0] instanceof AbortSignal,
    "signal must be an AbortSignal",
  );
  assert.equal(
    capturedSignals[0]?.aborted,
    false,
    "signal must not be pre-aborted",
  );
});

test("invokeJsonRpcWithFreshSession (re-attestation path) also passes AbortSignal to fetchImpl", async () => {
  let invokeCount = 0;
  const capturedSignals: Array<AbortSignal | undefined> = [];
  const client = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    fetchImpl: async (input, init) => {
      const url = String(input);

      if (url.endsWith("/v1/seal/attest")) {
        return jsonResponse({ security_token: "issued-token" });
      }

      if (url.endsWith("/v1/seal/invoke")) {
        invokeCount++;
        capturedSignals.push(init?.signal as AbortSignal | undefined);
        if (invokeCount === 1) {
          // First invoke returns 401 to force re-attestation path
          return new Response("Unauthorized", { status: 401 });
        }
        return jsonResponse({
          jsonrpc: "2.0",
          id: "req-reattest",
          result: { content: [{ type: "text", text: "ok" }], isError: false },
        });
      }

      return jsonResponse({}, 404);
    },
  });

  const user = {
    userId: "user-reattest",
    tier: "free",
    securityContext: "zaru-free",
    token: "jwt",
    isOperator: false,
  };

  await client.invokeTool(
    user,
    "aegis.execute.wait",
    { execution_id: "exec-2" },
    "req-reattest",
  );

  assert.equal(
    invokeCount,
    2,
    "should have retried via invokeJsonRpcWithFreshSession",
  );
  assert.equal(
    capturedSignals.length,
    2,
    "both invoke calls should capture a signal",
  );
  for (const signal of capturedSignals) {
    assert.ok(
      signal instanceof AbortSignal,
      "each signal must be an AbortSignal",
    );
    assert.equal(signal?.aborted, false, "signal must not be pre-aborted");
  }
});

test("invokeTool does NOT retry when 400 body contains 'session' in an unrelated error", async () => {
  let invokeCount = 0;
  const client = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    fetchImpl: async (input, init) => {
      const url = String(input);

      if (url.endsWith("/v1/seal/attest")) {
        return jsonResponse({ security_token: "issued-token" });
      }

      if (url.endsWith("/v1/seal/invoke")) {
        invokeCount++;
        // Simulate a non-session error that happens to contain the word "session"
        return new Response(
          "SEAL session error: aegis.execution.file: storage error",
          { status: 400 },
        );
      }

      return jsonResponse({}, 404);
    },
  });

  const user = {
    userId: "user-retry",
    tier: "free",
    securityContext: "zaru-free",
    token: "jwt",
    isOperator: false,
  };

  // A body outside AEGIS ADR-035's shape is not relayed: the caller is
  // told the generic failure as a tool result (adrs/035-updates R1, R5).
  const result = await client.invokeTool(
    user,
    "fs.read",
    { path: "/tmp/test" },
    "req-retry",
  );
  assert.deepEqual(result, {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: { code: "invoke_failed", message: "AEGIS invoke failed: 400" },
        }),
      },
    ],
    isError: true,
  });

  // Must NOT have retried — only one invoke call
  assert.equal(
    invokeCount,
    1,
    "should not retry on non-session 400 errors containing 'session'",
  );
});

// ── When to attest again ──────────────────────────────────────────────────
//
// The rule: a 401 is re-attested always; a 400 only when its body is a
// session condition in the words the orchestrator writes for it
// (`aegis-orchestrator` 675984dc, orchestrator/core/src/domain/seal_session.rs
// 161-162: "Session is inactive: {status:?}" and "Session has expired",
// answered by cli/src/daemon/handlers/seal.rs 605-610 as {"error": <text>});
// a 403 never, since a policy refusal is not cured by a new session. One
// re-attest and one retry at most.

/**
 * A client whose /v1/seal/invoke answers `answers` in turn (the last one
 * repeats) and whose /v1/seal/attest always succeeds, counting both.
 */
function reattestHarness(answers: Array<() => Response>) {
  const counts = { attest: 0, invoke: 0 };
  const client = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/seal/attest")) {
        counts.attest++;
        return jsonResponse({ security_token: `token-${counts.attest}` });
      }
      if (url.endsWith("/v1/seal/invoke")) {
        const answer = answers[Math.min(counts.invoke, answers.length - 1)];
        counts.invoke++;
        return answer();
      }
      return jsonResponse({}, 404);
    },
  });
  const user = {
    userId: "user-reattest-rule",
    tier: "free",
    securityContext: "zaru-free",
    token: "jwt",
    isOperator: false,
  };
  const call = () =>
    client.invokeTool(user, "aegis.task.list", {}, "req-reattest-rule");
  return { counts, call };
}

/** The generic failure the relay answers for a body it does not trust. */
const invokeFailed = (status: number) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        error: {
          code: "invoke_failed",
          message: `AEGIS invoke failed: ${status}`,
        },
      }),
    },
  ],
  isError: true,
});

const okAnswer = () =>
  jsonResponse({
    jsonrpc: "2.0",
    id: "req-reattest-rule",
    result: { content: [{ type: "text", text: "ok" }], isError: false },
  });

test("re-attest rule: a 400 for an expired session, as the orchestrator words it, is re-attested and retried once", async () => {
  const { counts, call } = reattestHarness([
    () => jsonResponse({ error: "Session has expired" }, 400),
    okAnswer,
  ]);
  const result = await call();
  assert.deepEqual(result, {
    content: [{ type: "text", text: "ok" }],
    isError: false,
  });
  assert.equal(counts.attest, 2, "the expired session is replaced");
  assert.equal(counts.invoke, 2, "the call is retried once");
});

test("re-attest rule: a 400 for an inactive session, as the orchestrator words it, is re-attested and retried once", async () => {
  const { counts, call } = reattestHarness([
    () =>
      jsonResponse(
        { error: 'Session is inactive: Revoked { reason: "rotated" }' },
        400,
      ),
    okAnswer,
  ]);
  await call();
  assert.equal(counts.attest, 2);
  assert.equal(counts.invoke, 2);
});

test("re-attest rule: a 401 is re-attested and retried once, whatever its body", async () => {
  for (const body of [
    "Unauthorized",
    JSON.stringify({ error: "operator_escalation_expired" }),
    JSON.stringify({
      protocol: "seal/v1",
      status: "error",
      error: { code: 1006, name: "SESSION_INACTIVE", message: "Attest again." },
    }),
  ]) {
    const { counts, call } = reattestHarness([
      () => new Response(body, { status: 401 }),
      okAnswer,
    ]);
    await call();
    assert.equal(counts.attest, 2, `re-attested on 401 ${body}`);
    assert.equal(counts.invoke, 2, `retried once on 401 ${body}`);
  }
});

test("re-attest rule: a 403 is not re-attested; it fails on the first answer", async () => {
  const { counts, call } = reattestHarness([
    () =>
      jsonResponse(
        {
          protocol: "seal/v1",
          status: "error",
          error: {
            code: 2000,
            name: "POLICY_VIOLATION_TOOL_NOT_ALLOWED",
            message: "Tool aegis.task.list is not allowed in zaru-free.",
          },
        },
        403,
      ),
    okAnswer,
  ]);
  // Not ADR-035's shape (a numeric code): told as the generic failure.
  assert.deepEqual(await call(), invokeFailed(403));
  assert.equal(counts.attest, 1, "no second attestation for a refusal");
  assert.equal(counts.invoke, 1, "no second call for a refusal");
});

test("re-attest rule: a 400 that is not one of the orchestrator's session texts is not re-attested", async () => {
  for (const error of [
    "Policy violation: tool aegis.task.list not allowed",
    "Invalid tool arguments: Session has expired",
    "SessionExpired",
    "SessionInactive",
  ]) {
    const { counts, call } = reattestHarness([
      () => jsonResponse({ error }, 400),
      okAnswer,
    ]);
    assert.deepEqual(await call(), invokeFailed(400));
    assert.equal(counts.attest, 1, `no re-attest for 400 ${error}`);
    assert.equal(counts.invoke, 1, `no retry for 400 ${error}`);
  }
});

test("re-attest rule: one re-attest and one retry at most", async () => {
  for (const [answer, status] of [
    [() => new Response("Unauthorized", { status: 401 }), 401],
    [() => jsonResponse({ error: "Session has expired" }, 400), 400],
  ] as const) {
    const { counts, call } = reattestHarness([answer]);
    assert.deepEqual(await call(), invokeFailed(status));
    assert.equal(counts.attest, 2);
    assert.equal(counts.invoke, 2);
  }
});

// ── SEAL Attestation: tenant derivation via JWT (cross-tenant leak fix) ───

// Regression: pre-fix, /v1/seal/attest was exempt from the orchestrator's
// auth middleware and the handler defaulted to TenantId::consumer() (a
// global singleton) when no explicit tenant_id was supplied. Every consumer
// MCP session received that singleton tenant, so subsequent
// enforce_tenant_arg comparisons leaked across users. The fix forwards the
// consumer user's Bearer token so the orchestrator can derive the tenant
// from the authenticated UserIdentity.

test("createSession forwards user.token as Authorization Bearer on /v1/seal/attest", async () => {
  const attestHeaders: Array<Record<string, string>> = [];
  const client = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/seal/attest")) {
        attestHeaders.push((init?.headers ?? {}) as Record<string, string>);
        return jsonResponse({ security_token: "tok" });
      }
      if (url.endsWith("/v1/seal/invoke")) {
        return jsonResponse({
          jsonrpc: "2.0",
          id: "r-auth",
          result: { content: [], isError: false },
        });
      }
      return jsonResponse({}, 404);
    },
  });

  const user = {
    userId: "u-auth",
    tier: "pro",
    securityContext: "zaru-pro",
    token: "keycloak-jwt-xyz",
    isOperator: false,
    tenantId: "t-team-abc",
  };

  await client.invokeTool(user, "aegis.agent.list", {}, "r-auth");

  assert.equal(attestHeaders.length, 1);
  assert.equal(
    attestHeaders[0]?.["Authorization"],
    "Bearer keycloak-jwt-xyz",
    "createSession must forward the user's Bearer token so the orchestrator can derive tenant from the authenticated identity",
  );
});

test("createSession omits tenant_id from attest body — orchestrator derives it from JWT", async () => {
  const attestBodies: Array<Record<string, unknown>> = [];
  const client = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/seal/attest")) {
        attestBodies.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return jsonResponse({ security_token: "tok" });
      }
      if (url.endsWith("/v1/seal/invoke")) {
        return jsonResponse({
          jsonrpc: "2.0",
          id: "r-no-tid",
          result: { content: [], isError: false },
        });
      }
      return jsonResponse({}, 404);
    },
  });

  // Even when the MCP server has resolved a tenantId locally (e.g. team
  // tenant from x-zaru-active-tenant), it MUST NOT be sent in the attest
  // body — the orchestrator authoritatively derives it from the JWT to
  // prevent the singleton-fallback leak. The team-context flow is carried
  // through other channels (the JWT itself + tenant middleware).
  const user = {
    userId: "u-no-tid",
    tier: "pro",
    securityContext: "zaru-pro",
    token: "jwt",
    isOperator: false,
    tenantId: "t-team-abc",
  };

  await client.invokeTool(user, "aegis.agent.list", {}, "r-no-tid");

  assert.equal(attestBodies.length, 1);
  assert.equal(
    Object.prototype.hasOwnProperty.call(attestBodies[0], "tenant_id"),
    false,
    "tenant_id must not be present in attest body — orchestrator derives it from JWT",
  );
});

test("createSession throws when user.token is missing (cannot attest without identity)", async () => {
  const client = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    fetchImpl: async () => {
      // Should never be called — must fail before fetch.
      throw new Error("fetch must not be invoked when token is missing");
    },
  });

  const user = {
    userId: "u-broken",
    tier: "free",
    securityContext: "zaru-free",
    // token intentionally absent — represents a misconfigured caller.
    token: "",
    isOperator: false,
  };

  await assert.rejects(
    () => client.invokeTool(user, "aegis.agent.list", {}, "r-broken"),
    (err: Error) => {
      assert.match(
        err.message,
        /cannot attest SEAL session without user Bearer token/,
      );
      return true;
    },
  );
});

test("session cache uses separate entries for same userId with different tenantIds", async () => {
  let attestCount = 0;
  const client = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    cacheTtlMs: 60_000,
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/seal/attest")) {
        attestCount++;
        return jsonResponse({ security_token: `tok-${attestCount}` });
      }
      if (url.endsWith("/v1/seal/invoke")) {
        return jsonResponse({
          jsonrpc: "2.0",
          id: "r3",
          result: { content: [], isError: false },
        });
      }
      return jsonResponse({}, 404);
    },
  });

  const baseUser = {
    userId: "shared-user",
    tier: "pro",
    securityContext: "zaru-pro",
    token: "jwt",
    isOperator: false,
  };

  const userPersonal = { ...baseUser, tenantId: undefined };
  const userTeam = { ...baseUser, tenantId: "t-team-xyz" };

  // First call for personal tenant — attests once
  await client.invokeTool(userPersonal, "aegis.agent.list", {}, "r3a");
  // Second call for team tenant — must attest again (different cache key)
  await client.invokeTool(userTeam, "aegis.agent.list", {}, "r3b");
  // Third call for personal tenant — must use cached session, no new attest
  await client.invokeTool(userPersonal, "aegis.agent.list", {}, "r3c");

  assert.equal(
    attestCount,
    2,
    "should attest twice: once per distinct tenantId, personal reuses cache",
  );
});

// The wait ceiling (Zaru ADR-0045; AEGIS known-defects-4). The Worker's
// entrypoint passes it (src/worker.ts), proved in the Workers runtime by
// test/wait-ceiling.worker.test.ts; these pin the client's rule and that a
// client built without the option applies none.

const waitUser = {
  userId: "user-wait",
  tier: "pro",
  securityContext: "zaru-pro",
  token: "jwt",
  isOperator: false,
};

/** A client whose orchestrator records each tools/call's arguments and
 *  answers with `answer(name, args)`. */
function waitClient(
  answer: (name: string, args: Record<string, unknown>) => unknown,
  waitCeilingSeconds?: number | null,
) {
  const forwarded: Array<Record<string, unknown>> = [];
  const client = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    toolDiscoveryUrl: "http://aegis.test/v1/seal/tools",
    ...(waitCeilingSeconds !== undefined ? { waitCeilingSeconds } : {}),
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/seal/attest")) {
        return jsonResponse({ security_token: "issued-token" });
      }
      if (url.endsWith("/v1/seal/tools")) {
        return jsonResponse({
          tools: [
            { name: "aegis.task.wait", description: "Waits.", inputSchema: { type: "object" } },
            { name: "aegis.task.status", description: "Status.", inputSchema: { type: "object" } },
          ],
        });
      }
      const envelope = JSON.parse(String(init?.body)) as {
        payload: { params: { name: string; arguments: Record<string, unknown> } };
      };
      forwarded.push(envelope.payload.params.arguments);
      return jsonResponse({
        jsonrpc: "2.0",
        id: null,
        result: answer(envelope.payload.params.name, envelope.payload.params.arguments),
      });
    },
  });
  return { client, forwarded };
}

const RUNNING = "3c1d7a52-9e0b-4f6a-8d21-5b7e9f0c2a14";

function stillRunning(_name: string, args: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          tool: "aegis.task.wait",
          execution_id: args.execution_id,
          status: "running",
          timed_out: true,
          message: `Execution still running after ${String(args.timeout_seconds)}s timeout`,
          iteration_count: 3,
        }),
      },
    ],
    isError: false,
  };
}

test("wait ceiling: the Worker's ceiling is 45 seconds", () => {
  assert.equal(WAIT_CEILING_SECONDS, 45);
});

test("wait ceiling: a client built without waitCeilingSeconds applies none, so the container's entrypoints keep the orchestrator's wait", async () => {
  const { client, forwarded } = waitClient(stillRunning);
  const result = await client.invokeTool(
    waitUser,
    "aegis.task.wait",
    { execution_id: RUNNING, timeout_seconds: 300 },
    null,
  );
  assert.deepEqual(forwarded, [{ execution_id: RUNNING, timeout_seconds: 300 }]);
  assert.deepEqual(result, stillRunning("aegis.task.wait", forwarded[0]!));
  const tools = await client.listTools(waitUser);
  assert.equal(tools[0]?.description, "Waits.");
});

test("wait ceiling: timeout_seconds above the ceiling, absent, or not a whole number is asked for as the ceiling; at or under it, as sent", async () => {
  const { client, forwarded } = waitClient(stillRunning, 45);
  const cases: Array<[Record<string, unknown>, number]> = [
    [{ execution_id: RUNNING, timeout_seconds: 300 }, 45],
    [{ execution_id: RUNNING }, 45],
    [{ execution_id: RUNNING, timeout_seconds: 10.5 }, 45],
    [{ execution_id: RUNNING, timeout_seconds: "30" }, 45],
    [{ execution_id: RUNNING, timeout_seconds: 45 }, 45],
    [{ execution_id: RUNNING, timeout_seconds: 10 }, 10],
  ];
  for (const [args] of cases) {
    await client.invokeTool(waitUser, "aegis.task.wait", args, null);
  }
  assert.deepEqual(
    forwarded.map((a) => a.timeout_seconds),
    cases.map(([, expected]) => expected),
  );
});

test("wait ceiling: a wait still running at the bound answers a tool result that says so and how to continue", async () => {
  const { client } = waitClient(stillRunning, 45);
  const result = (await client.invokeTool(
    waitUser,
    "aegis.task.wait",
    { execution_id: RUNNING, timeout_seconds: 300 },
    null,
  )) as { content: Array<{ text: string }>; isError: boolean };
  assert.equal(result.isError, false);
  const answer = JSON.parse(result.content[0]!.text);
  assert.deepEqual(answer, {
    tool: "aegis.task.wait",
    execution_id: RUNNING,
    status: "running",
    iteration_count: 3,
    still_running: true,
    timed_out: true,
    waited_seconds: 45,
    message: `Execution ${RUNNING} is still running after 45s, iteration count 3. Repeat this same aegis.task.wait call to continue waiting.`,
  });
});

test("wait ceiling: a finished execution's result comes back as the orchestrator sent it", async () => {
  const finished = {
    tool: "aegis.task.wait",
    execution_id: RUNNING,
    status: "completed",
    iteration_count: 1,
    last_output: "done",
  };
  const { client } = waitClient(() => finished, 45);
  const result = await client.invokeTool(
    waitUser,
    "aegis.task.wait",
    { execution_id: RUNNING, timeout_seconds: 300 },
    null,
  );
  assert.deepEqual(result, finished);
});

test("wait ceiling: a tool whose name does not end in .wait is forwarded untouched", async () => {
  const { client, forwarded } = waitClient(() => ({ timed_out: true }), 45);
  const args = { execution_id: RUNNING, timeout_seconds: 300 };
  const result = await client.invokeTool(waitUser, "aegis.task.status", args, null);
  assert.deepEqual(forwarded, [args]);
  assert.deepEqual(result, { timed_out: true });
});

test("wait ceiling: the wait tools' descriptions name the ceiling, and no other tool's changes", async () => {
  const { client } = waitClient(() => null, 45);
  const tools = await client.listTools(waitUser);
  assert.match(tools[0]?.description ?? "", /^Waits\. On this server one call waits at most 45 seconds/);
  assert.equal(tools[1]?.description, "Status.");
});

// ── The operator escalation's two routes (Zaru ADR-0050 D3, D4; Update U1, U2)

const escalatingUser = {
  userId: "5a1e0000-consumer",
  tier: "pro",
  securityContext: "zaru-pro",
  token: "aegis_operator_consumer_key",
  isOperator: false,
};

function recordingClient(respond: () => Response | Promise<Response>) {
  const calls: Array<{
    url: string;
    method?: string;
    headers: Record<string, string>;
    body?: string;
  }> = [];
  const client = new OrchestratorClient({
    baseUrl: "http://aegis.test/",
    fetchImpl: async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body as string | undefined,
      });
      return respond();
    },
  });
  return { client, calls };
}

test("redeemOperatorEscalation posts {code} to /v1/operator-escalations with the caller's own token", async () => {
  const { client, calls } = recordingClient(() =>
    jsonResponse({ aegis_role: "aegis:operator", expires_at: "2026-10-04T07:00:00Z" }),
  );
  const answer = await client.redeemOperatorEscalation(escalatingUser, "042917");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://aegis.test/v1/operator-escalations");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.headers["Authorization"], "Bearer aegis_operator_consumer_key");
  assert.equal(calls[0]?.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0]!.body!), { code: "042917" });
  assert.deepEqual(answer, {
    ok: true,
    body: { aegis_role: "aegis:operator", expires_at: "2026-10-04T07:00:00Z" },
  });
});

test("releaseOperatorEscalation deletes /v1/operator-escalations/current with the caller's own token", async () => {
  const { client, calls } = recordingClient(() =>
    jsonResponse({ ended_at: "2026-10-04T06:40:00Z" }),
  );
  const answer = await client.releaseOperatorEscalation(escalatingUser);
  assert.equal(calls[0]?.url, "http://aegis.test/v1/operator-escalations/current");
  assert.equal(calls[0]?.method, "DELETE");
  assert.equal(calls[0]?.headers["Authorization"], "Bearer aegis_operator_consumer_key");
  assert.equal(calls[0]?.body, undefined);
  assert.deepEqual(answer, { ok: true, body: { ended_at: "2026-10-04T06:40:00Z" } });
});

test("an orchestrator refusal {error, message} is returned unchanged (Update U1)", async () => {
  for (const [status, refusal] of [
    [400, { error: "invalid_code", message: "the code is not valid for this key" }],
    [400, { error: "code_expired", message: "the code has expired; generate a new one" }],
    [403, { error: "escalation_requires_api_key", message: "only an API key can hold an operator escalation" }],
    [404, { error: "escalation_not_found", message: "this key holds no active escalation" }],
  ] as const) {
    const { client } = recordingClient(() => jsonResponse(refusal, status));
    assert.deepEqual(
      await client.redeemOperatorEscalation(escalatingUser, "123456"),
      { ok: false, refusal },
    );
  }
});

test("an unreachable orchestrator is orchestrator_unavailable (Update U2)", async () => {
  const { client } = recordingClient(() => {
    throw new TypeError("fetch failed");
  });
  const answer = await client.redeemOperatorEscalation(escalatingUser, "123456");
  assert.equal(answer.ok, false);
  assert.equal(!answer.ok && answer.refusal.error, "orchestrator_unavailable");
  assert.match(!answer.ok ? answer.refusal.message : "", /fetch failed/);
});

test("an answer without an error object is orchestrator_unavailable with the status seen (Update U2)", async () => {
  for (const [status, body] of [
    [502, "<html>Bad gateway</html>"],
    [500, JSON.stringify({ message: "no code" })],
    [400, JSON.stringify(["not", "an", "object"])],
    [200, "not json"],
  ] as const) {
    const { client } = recordingClient(
      () => new Response(body, { status, headers: { "Content-Type": "application/json" } }),
    );
    const answer = await client.releaseOperatorEscalation(escalatingUser);
    assert.equal(answer.ok, false, `${status} ${body}`);
    assert.equal(!answer.ok && answer.refusal.error, "orchestrator_unavailable");
    assert.match(!answer.ok ? answer.refusal.message : "", new RegExp(`HTTP ${status}`));
  }
});
