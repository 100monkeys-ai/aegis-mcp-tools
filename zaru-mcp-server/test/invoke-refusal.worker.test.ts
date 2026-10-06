// The relay of the orchestrator's refusals on the Workers entrypoint (Zaru
// ADR-0045; AEGIS ADR-035, Update R1 to R8): a tools/call the orchestrator
// refuses comes back to the MCP client as a JSON-RPC result whose tool
// result has isError true, never as a JSON-RPC error. A caller-facing
// refusal carries the orchestrator's code and message, an internal failure
// its fixed sentence, a body outside ADR-035's shape the generic failure.
//
// Run in the Workers runtime (wrangler's local workerd), as
// wait-ceiling.worker.test.ts is, against a stub orchestrator that refuses
// each tool in the orchestrator's own shape (`aegis-orchestrator` 0c60875b,
// `cli/src/daemon/handlers/seal.rs` 606-667).

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

const REQUEST_ID = "0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a";
const NOT_ALLOWED =
  "Policy violation: tool 'aegis.task.list' is not allowed; permitted tools: [zaru.*]";
const LEAK =
  "Internal error: Database error: relation \"tenants\" does not exist at /aegis/volumes/0b6c/workspace";

let stub: Server;
let stubUrl: string;
let worker: Unstable_DevWorker;
let signingKey: CryptoKey;
let jwk: Record<string, unknown>;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function adr035(code: string, message: string, status: string) {
  return {
    protocol: "seal/v1",
    request_id: REQUEST_ID,
    status,
    error: { code, message, context: null, tool: null },
  };
}

/** The stub orchestrator's answer to a tools/call of `name`. */
function refusalFor(name: string): { status: number; body: unknown } {
  switch (name) {
    case "aegis.task.list":
      return {
        status: 403,
        body: adr035("TOOL_NOT_ALLOWED", NOT_ALLOWED, "policy_violation"),
      };
    case "aegis.system.info":
      return { status: 500, body: adr035("INTERNAL_ERROR", LEAK, "error") };
    default:
      return { status: 400, body: { error: LEAK } };
  }
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
      sendJson(200, { tools: [] });
      return;
    }
    if (url.pathname === "/v1/seal/attest" && req.method === "POST") {
      await readBody(req);
      sendJson(200, { security_token: "stub-security-token" });
      return;
    }
    if (url.pathname === "/v1/seal/invoke" && req.method === "POST") {
      const envelope = JSON.parse(await readBody(req)) as {
        payload: { params: { name: string } };
      };
      const { status, body } = refusalFor(envelope.payload.params.name);
      sendJson(status, body);
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
    .setSubject("invoke-refusal-test-user")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
}

/** A tools/call through the Worker; the whole JSON-RPC answer. */
async function callTool(name: string) {
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
      params: { name, arguments: {} },
    }),
  });
  assert.equal(res.status, 200, `tools/call ${name} answered ${res.status}`);
  return (await res.json()) as {
    result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
    error?: { code: number; message: string };
  };
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

test("worker: a policy refusal is a tool result with the orchestrator's code, message and request_id, not a JSON-RPC error", async () => {
  const answer = await callTool("aegis.task.list");
  assert.equal(answer.error, undefined, `a JSON-RPC error: ${JSON.stringify(answer.error)}`);
  assert.equal(answer.result?.isError, true);
  assert.deepEqual(JSON.parse(answer.result!.content[0]!.text), {
    error: { code: "TOOL_NOT_ALLOWED", message: NOT_ALLOWED },
    request_id: REQUEST_ID,
  });
});

test("worker: an internal failure is told by its fixed sentence, none of the body's detail", async () => {
  const answer = await callTool("aegis.system.info");
  assert.equal(answer.error, undefined);
  assert.equal(answer.result?.isError, true);
  const text = answer.result!.content[0]!.text;
  assert.deepEqual(JSON.parse(text), {
    error: {
      code: "INTERNAL_ERROR",
      message: "The request could not be completed because of an internal error.",
    },
    request_id: REQUEST_ID,
  });
  assert.doesNotMatch(text, /Database|tenants|volumes/);
});

test("worker: a body outside ADR-035's shape is the generic failure, none of its text", async () => {
  const answer = await callTool("aegis.task.status");
  assert.equal(answer.error, undefined);
  assert.equal(answer.result?.isError, true);
  const text = answer.result!.content[0]!.text;
  assert.deepEqual(JSON.parse(text), {
    error: { code: "invoke_failed", message: "AEGIS invoke failed: 400" },
  });
  assert.doesNotMatch(text, /Database|tenants|volumes/);
});
