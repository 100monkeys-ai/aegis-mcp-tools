import test from "node:test";
import assert from "node:assert/strict";
import { OrchestratorClient } from "../src/mcp/orchestrator-client.js";

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

  await client.streamExecution(user, "exec-abc");

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    "http://aegis.test/v1/executions/exec-abc/events",
  );
  assert.ok(
    !calls[0]?.url.includes("?token="),
    "URL must not contain ?token= query param",
  );
  assert.equal(calls[0]?.headers["Authorization"], "Bearer keycloak-jwt-xyz");
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
  };

  await assert.rejects(
    () =>
      client.invokeTool(user, "fs.read", { path: "/tmp/test" }, "req-retry"),
    (err: Error) => {
      assert.match(err.message, /AEGIS invoke failed: 400/);
      assert.match(err.message, /storage error/);
      return true;
    },
  );

  // Must NOT have retried — only one invoke call
  assert.equal(
    invokeCount,
    1,
    "should not retry on non-session 400 errors containing 'session'",
  );
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
