// The wait ceiling of the Workers entrypoint (Zaru ADR-0045; AEGIS
// known-defects-4, "aegis.task.wait through the Zaru MCP server cannot be
// awaited for its own default"): an MCP client gives up on a tool call after
// about a minute, and the orchestrator's wait tools block for up to their own
// default of 300 seconds or more. On the Worker a tool whose name ends in
// ".wait" asks the orchestrator for at most WAIT_CEILING_SECONDS, and an
// execution still running at that bound comes back as an ordinary tool result
// that says so and says that repeating the call continues the wait.
//
// Run in the Workers runtime (wrangler's local workerd), as
// worker-runtime.worker.test.ts is, against a stub orchestrator that records
// the arguments of every tools/call it receives and answers each wait at once
// in the orchestrator's own shapes (`aegis-orchestrator` 02361624,
// `tool_invocation_service/tasks.rs` lines 238 to 246 and `workflows.rs`
// lines 459 to 467).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

const RUNNING_ID = "3c1d7a52-9e0b-4f6a-8d21-5b7e9f0c2a14";
const FINISHED_ID = "8f2e4b61-0a3c-4d5e-9b7f-1c2d3e4f5a6b";
const WORKFLOW_RUNNING_ID = "c4a9e2d1-7b3f-4e8a-a1c6-0d5f2b9e7c83";

const FINISHED_RESULT = {
  agent_id: "26c335ea-0bb0-4f1c-8c28-f29599ca64d3",
  ended_at: "2026-10-01T10:28:07.022060Z",
  execution_id: FINISHED_ID,
  iteration_count: 4,
  last_error: null,
  last_output: "done",
  started_at: "2026-10-01T10:18:01.628058Z",
  status: "completed",
  tool: "aegis.task.wait",
};

const WAIT_DESCRIPTION =
  "Polls an execution until it reaches a terminal state and returns the result.";
const STATUS_DESCRIPTION = "Returns the status of an execution.";

let stub: Server;
let stubUrl: string;
let worker: Unstable_DevWorker;
let signingKey: CryptoKey;
let jwk: Record<string, unknown>;

/** Every tools/call the stub orchestrator received, in order. */
const invoked: Array<{ name: string; arguments: Record<string, unknown> }> = [];

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

/** The orchestrator's answer to a wait, given the timeout it was asked for. */
function waitResult(
  name: string,
  args: Record<string, unknown>,
): unknown {
  const timeout =
    typeof args.timeout_seconds === "number" ? args.timeout_seconds : 300;
  if (args.execution_id === FINISHED_ID) return FINISHED_RESULT;
  if (args.execution_id === WORKFLOW_RUNNING_ID) {
    // The workflow wait's still-running shape, wrapped as an MCP tool
    // result, the other form the Worker can receive.
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            tool: name,
            execution_id: WORKFLOW_RUNNING_ID,
            status: "running",
            current_state: "review",
            timed_out: true,
            message: `Workflow execution still running after ${timeout}s timeout`,
          }),
        },
      ],
      isError: false,
    };
  }
  return {
    tool: name,
    execution_id: args.execution_id,
    status: "running",
    timed_out: true,
    message: `Execution still running after ${timeout}s timeout`,
    iteration_count: 2,
  };
}

function startStub(): Promise<void> {
  stub = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/realms/zaru-consumer/protocol/openid-connect/certs") {
      sendJson(200, { keys: [jwk] });
      return;
    }
    if (url.pathname === "/v1/seal/tools" && req.method === "GET") {
      sendJson(200, {
        tools: [
          {
            name: "aegis.task.wait",
            description: WAIT_DESCRIPTION,
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "aegis.workflow.wait",
            description: "Polls a workflow execution until it reaches a terminal state and returns the result.",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "aegis.task.status",
            description: STATUS_DESCRIPTION,
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
      return;
    }
    if (url.pathname === "/v1/seal/attest" && req.method === "POST") {
      await readBody(req);
      sendJson(200, { security_token: "stub-security-token" });
      return;
    }
    if (url.pathname === "/v1/seal/invoke" && req.method === "POST") {
      const envelope = JSON.parse(await readBody(req)) as {
        payload: {
          id: unknown;
          params: { name: string; arguments: Record<string, unknown> };
        };
      };
      const { name, arguments: args } = envelope.payload.params;
      invoked.push({ name, arguments: args });
      const result = name.endsWith(".wait")
        ? waitResult(name, args)
        : { tool: name, execution_id: args.execution_id, status: "running" };
      sendJson(200, { jsonrpc: "2.0", id: envelope.payload.id, result });
      return;
    }
    sendJson(404, { error: "stub: no such route" });
  });
  return new Promise((resolve) => {
    stub.listen(0, "127.0.0.1", () => {
      const { port } = stub.address() as AddressInfo;
      stubUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

async function userToken(): Promise<string> {
  return new SignJWT({ zaru_tier: "pro" })
    .setProtectedHeader({ alg: "RS256", kid: "stub" })
    .setIssuer(`${stubUrl}/realms/zaru-consumer`)
    .setSubject("wait-ceiling-test-user")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
}

/** A tools/call through the Worker; the tool result and the arguments the
 *  orchestrator received for it. */
async function callTool(name: string, args: Record<string, unknown>) {
  const before = invoked.length;
  const res = await worker.fetch("/mcp/v1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${await userToken()}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  assert.equal(res.status, 200, `tools/call ${name} answered ${res.status}`);
  const body = (await res.json()) as {
    result: { content: Array<{ type: string; text: string }>; isError?: boolean };
  };
  const received = invoked.slice(before);
  assert.equal(received.length, 1, `the orchestrator received ${received.length} calls`);
  return { result: body.result, forwarded: received[0]!.arguments };
}

before(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "stub", alg: "RS256", use: "sig" };
  await startStub();
  worker = await unstable_dev("src/worker.ts", {
    config: "wrangler.jsonc",
    env: "staging",
    ip: "127.0.0.1",
    port: 0,
    logLevel: "warn",
    vars: {
      AEGIS_ORCHESTRATOR_URL: stubUrl,
      ZARU_CLIENT_URL: stubUrl,
      JWKS_URI: `${stubUrl}/realms/zaru-consumer/protocol/openid-connect/certs`,
    },
    experimental: { disableExperimentalWarning: true },
  });
});

after(async () => {
  await worker?.stop();
  await new Promise<void>((resolve) => stub?.close(() => resolve()));
});

test("wait ceiling: aegis.task.wait with timeout_seconds 300 asks the orchestrator for at most 45 and answers that the execution is still running", async () => {
  const { result, forwarded } = await callTool("aegis.task.wait", {
    execution_id: RUNNING_ID,
    timeout_seconds: 300,
  });
  assert.equal(
    forwarded.timeout_seconds,
    45,
    `the Worker asked the orchestrator to wait ${String(forwarded.timeout_seconds)} seconds, not at most 45`,
  );
  assert.equal(forwarded.execution_id, RUNNING_ID);
  assert.equal(result.isError, false);
  const answer = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  assert.equal(answer.execution_id, RUNNING_ID);
  assert.equal(answer.status, "running");
  assert.equal(answer.iteration_count, 2);
  assert.equal(answer.still_running, true, "the answer does not say the execution is still running");
  assert.equal(answer.waited_seconds, 45, "the answer does not give the seconds waited");
  assert.match(
    String(answer.message),
    /Repeat this same aegis\.task\.wait call to continue waiting\./,
    `the answer does not say that repeating the call continues the wait: ${String(answer.message)}`,
  );
});

test("wait ceiling: a wait with no timeout_seconds asks the orchestrator for 45, not its own default", async () => {
  const { forwarded } = await callTool("aegis.task.wait", {
    execution_id: RUNNING_ID,
  });
  assert.equal(
    forwarded.timeout_seconds,
    45,
    `the Worker left the wait to the orchestrator's default (timeout_seconds ${String(forwarded.timeout_seconds)})`,
  );
});

test("wait ceiling: a caller's timeout_seconds of 10 is asked for as 10", async () => {
  const { forwarded } = await callTool("aegis.task.wait", {
    execution_id: RUNNING_ID,
    timeout_seconds: 10,
  });
  assert.equal(forwarded.timeout_seconds, 10);
});

test("wait ceiling: a finished execution's result is returned unchanged", async () => {
  const { result } = await callTool("aegis.task.wait", {
    execution_id: FINISHED_ID,
    timeout_seconds: 300,
  });
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content[0]!.text), FINISHED_RESULT);
});

test("wait ceiling: aegis.workflow.wait still running at the bound says so, with its state", async () => {
  const { result, forwarded } = await callTool("aegis.workflow.wait", {
    execution_id: WORKFLOW_RUNNING_ID,
    timeout_seconds: 600,
  });
  assert.equal(forwarded.timeout_seconds, 45);
  const answer = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  assert.equal(answer.execution_id, WORKFLOW_RUNNING_ID);
  assert.equal(answer.status, "running");
  assert.equal(answer.current_state, "review");
  assert.equal(answer.still_running, true);
  assert.equal(answer.waited_seconds, 45);
  assert.match(
    String(answer.message),
    /Repeat this same aegis\.workflow\.wait call to continue waiting\./,
  );
});

test("wait ceiling: a tool whose name does not end in .wait is forwarded untouched", async () => {
  const args = {
    execution_id: RUNNING_ID,
    timeout_seconds: 300,
    poll_interval_seconds: 7,
  };
  const { result, forwarded } = await callTool("aegis.task.status", args);
  assert.deepEqual(forwarded, args);
  assert.deepEqual(JSON.parse(result.content[0]!.text), {
    tool: "aegis.task.status",
    execution_id: RUNNING_ID,
    status: "running",
  });
});

test("wait ceiling: the served descriptions of the wait tools name the 45-second ceiling", async () => {
  const res = await worker.fetch("/mcp/v1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${await userToken()}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    result: { tools: Array<{ name: string; description?: string }> };
  };
  const byName = new Map(body.result.tools.map((t) => [t.name, t.description ?? ""]));
  for (const name of ["aegis.task.wait", "aegis.workflow.wait"]) {
    assert.match(
      byName.get(name) ?? "",
      /at most 45 seconds/,
      `the served description of ${name} does not name the ceiling: ${byName.get(name)}`,
    );
  }
  assert.ok((byName.get("aegis.task.wait") ?? "").startsWith(WAIT_DESCRIPTION));
  assert.equal(byName.get("aegis.task.status"), STATUS_DESCRIPTION);
});
