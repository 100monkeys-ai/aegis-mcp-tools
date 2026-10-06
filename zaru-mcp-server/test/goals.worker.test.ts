// Goals pass through this server unchanged (AEGIS ADR-131, its Update U6 to
// U8; Zaru ADR-0049 — Updates, the Update of 2026-10-04, G2 and G6).
//
// The orchestrator holds the goal and serves the three goal tools; Zaru
// Web's turn creates and evaluates the goal and inserts `goal_id` into the
// four starting tools' calls. This server changes nothing for it, and these
// tests pin that it stays so:
//
// - U8: "The MCP server lists them with no change of its own": the goal
//   tools the orchestrator lists for the caller's security context are
//   listed as served.
// - U7: `aegis.goal.evaluate` bounds itself at 45 s on the orchestrator's
//   side; it is not a wait tool here, so its arguments are forwarded
//   untouched, with no `timeout_seconds` added.
// - U6 / G2: `goal_id` inserted by the turn into a starting tool's
//   arguments reaches the orchestrator intact.
// - G6: "D1's output gains `goal`": `zaru.chat` returns Zaru Web's answer,
//   `goal` included, unchanged.
//
// Run in the Workers runtime (wrangler's local workerd), as
// wait-ceiling.worker.test.ts is, against a stub orchestrator and a stub
// Zaru Web turn route written from the records' shapes (the orchestrator's
// half is not landed at the time of writing).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

const GOAL_ID = "5b0f3c2e-8d4a-4e1b-9a6c-2f7d1e0b3a94";
const CONVERSATION_ID = "0c9e4d7a-3b2f-4a61-8e5d-7f1a2b3c4d5e";

/** The three goal tools as the orchestrator would serve them (U8's shapes). */
const GOAL_TOOLS = [
  {
    name: "aegis.goal.create",
    description: "Creates a goal for the caller.",
    inputSchema: {
      type: "object",
      properties: {
        statement: { type: "string", maxLength: 32768 },
        client_ref: { type: "string" },
        channel: { type: "string", enum: ["web", "api"] },
      },
      required: ["statement", "client_ref", "channel"],
    },
  },
  {
    name: "aegis.goal.evaluate",
    description: "Judges a goal after an execution turn.",
    inputSchema: {
      type: "object",
      properties: {
        goal_id: { type: "string" },
        companion_answer: { type: "string" },
        round: { type: "integer" },
      },
      required: ["goal_id", "companion_answer"],
    },
  },
  {
    name: "aegis.goal.status",
    description: "Reads a goal, its executions and its verdicts.",
    inputSchema: {
      type: "object",
      properties: { goal_id: { type: "string" } },
      required: ["goal_id"],
    },
  },
];

/** D6's answer for a goal not met, with a round granted (U8). */
const EVALUATE_ANSWER = {
  goal_id: GOAL_ID,
  state: "open",
  round: 1,
  rounds_left: 2,
  verdict: {
    score: 0.4,
    confidence: 0.9,
    reasoning: "The agent was created; it was not run on the word.",
    signals: [],
  },
  outcome: "not_met",
  continue: true,
  executions: [
    {
      execution_id: "a1b2c3d4-0000-4000-8000-000000000001",
      status: "completed",
      agent_or_workflow: "agent-creator-agent",
    },
  ],
};

/** Zaru Web's turn answer, D1's object with G6's `goal`. */
const TURN_ANSWER = {
  conversation_id: CONVERSATION_ID,
  status: "complete",
  answer: "palindrome-checker is ready; running it now.",
  tool_calls: [],
  model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
  mode: "agentic",
  goal: {
    goal_id: GOAL_ID,
    statement: 'Create a new agent called palindrome-checker, then run it on the word "racecar".',
    state: "open",
    rounds: 1,
    verdicts: [
      {
        round: 0,
        score: 0.4,
        confidence: 0.9,
        outcome: "not_met",
        reasoning: "The agent was created; it was not run on the word.",
      },
    ],
  },
};

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
          ...GOAL_TOOLS,
          {
            name: "aegis.task.execute",
            description: "Runs an agent.",
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
      const result =
        name === "aegis.goal.evaluate"
          ? EVALUATE_ANSWER
          : { tool: name, execution_id: "a1b2c3d4-0000-4000-8000-000000000002", status: "started" };
      sendJson(200, { jsonrpc: "2.0", id: envelope.payload.id, result });
      return;
    }
    if (url.pathname === "/api/chat/turn" && req.method === "POST") {
      await readBody(req);
      sendJson(200, TURN_ANSWER);
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
    .setSubject("goals-test-user")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
}

async function rpc(method: string, params: Record<string, unknown>) {
  const res = await worker.fetch("/mcp/v1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${await userToken()}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(res.status, 200, `${method} answered ${res.status}`);
  return (await res.json()) as { result: Record<string, unknown> };
}

/** A tools/call through the Worker; the tool result and the arguments the
 *  orchestrator received for it. */
async function callTool(name: string, args: Record<string, unknown>) {
  const before = invoked.length;
  const body = await rpc("tools/call", { name, arguments: args });
  const result = body.result as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  const received = invoked.slice(before);
  assert.equal(received.length, 1, `the orchestrator received ${received.length} calls`);
  assert.equal(received[0]!.name, name);
  return { result, forwarded: received[0]!.arguments };
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
    persist: false,
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

test("U8: the goal tools the orchestrator serves are listed as served", async () => {
  const body = await rpc("tools/list", {});
  const tools = (body.result as { tools: Array<Record<string, unknown>> }).tools;
  for (const served of GOAL_TOOLS) {
    const listed = tools.filter((t) => t.name === served.name);
    assert.equal(listed.length, 1, `${served.name} is listed once`);
    assert.deepEqual(listed[0], served, `${served.name} is listed unchanged`);
  }
});

test("U7: aegis.goal.evaluate is forwarded with its arguments untouched and no wait ceiling", async () => {
  const args = {
    goal_id: GOAL_ID,
    companion_answer: "palindrome-checker is ready; running it now.",
    round: 1,
  };
  const { result, forwarded } = await callTool("aegis.goal.evaluate", args);
  assert.deepEqual(forwarded, args);
  assert.ok(!("timeout_seconds" in forwarded), "no timeout_seconds is added");
  assert.notEqual(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0]!.text), EVALUATE_ANSWER);
});

test("U6 / G2: goal_id inserted into a starting tool's arguments reaches the orchestrator intact", async () => {
  const args = {
    agent_id: "palindrome-checker",
    input: { prompt: 'Run it on the word "racecar".' },
    goal_id: GOAL_ID,
  };
  const { forwarded } = await callTool("aegis.task.execute", args);
  assert.deepEqual(forwarded, args);
  assert.equal(forwarded.goal_id, GOAL_ID);
});

test("G6: zaru.chat returns Zaru Web's answer with its goal field unchanged", async () => {
  const before = invoked.length;
  const body = await rpc("tools/call", {
    name: "zaru.chat",
    arguments: { message: "keep going", conversation_id: CONVERSATION_ID },
  });
  const result = body.result as {
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  assert.equal(invoked.length, before, "zaru.chat is never forwarded to the orchestrator");
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, TURN_ANSWER);
  assert.deepEqual(JSON.parse(result.content[0]!.text), TURN_ANSWER);
});
