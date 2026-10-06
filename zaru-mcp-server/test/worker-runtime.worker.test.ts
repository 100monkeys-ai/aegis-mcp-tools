// The Workers entrypoint (src/worker.ts) run in the Workers runtime: wrangler's
// local dev server (workerd) with the staging environment of wrangler.jsonc and
// nodejs_compat, its upstreams replaced by a stub on loopback. `npm run
// worker:test` runs this file alone; `npm test` runs it with the rest.
//
// The stub stands in for Keycloak (a JWKS for an RS256 key this file signs
// tokens with), the orchestrator's SEAL endpoints (tool discovery, attest,
// invoke, which checks the envelope's Ed25519 signature against the public
// key the Worker attested with) and the execution event stream.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";
import { stableStringify } from "../src/mcp/seal.js";

const EXECUTION_ID = "0b6f5c8e-2f7a-4c1e-9a53-6d2b1f0e4a77";
const STUB_TOOL = "aegis.stub.echo";

let stub: Server;
let stubUrl: string;
let worker: Unstable_DevWorker;
let signingKey: CryptoKey;
let jwk: Record<string, unknown>;

/** What the stub saw of the SEAL exchange. */
const seal: {
  publicKeyRaw?: Buffer;
  verified: boolean[];
} = { verified: [] };

/** Released by the test once it has read the stream's first event. */
let releaseSecondEvent: () => void = () => {};

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
          {
            name: STUB_TOOL,
            description: "Echo, from the stub orchestrator",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
      return;
    }
    if (url.pathname === "/v1/seal/attest" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as { public_key: string };
      seal.publicKeyRaw = Buffer.from(body.public_key, "base64");
      sendJson(200, { security_token: "stub-security-token" });
      return;
    }
    if (url.pathname === "/v1/seal/invoke" && req.method === "POST") {
      const envelope = JSON.parse(await readBody(req)) as {
        security_token: string;
        signature: string;
        payload: { id: unknown };
        timestamp: string;
      };
      // The orchestrator's check: the canonical message, signed with the
      // session key the Worker attested (src/mcp/seal.ts).
      const message = Buffer.from(
        stableStringify({
          payload: envelope.payload,
          security_token: envelope.security_token,
          timestamp: Math.floor(new Date(envelope.timestamp).getTime() / 1000),
        }),
        "utf-8",
      );
      const publicKey = createPublicKey({
        key: {
          kty: "OKP",
          crv: "Ed25519",
          x: (seal.publicKeyRaw ?? Buffer.alloc(0)).toString("base64url"),
        },
        format: "jwk",
      });
      const ok = verify(
        null,
        message,
        publicKey,
        Buffer.from(envelope.signature, "base64"),
      );
      seal.verified.push(ok);
      if (!ok) {
        sendJson(401, { error: "bad signature" });
        return;
      }
      sendJson(200, {
        jsonrpc: "2.0",
        id: envelope.payload.id,
        result: { content: [{ type: "text", text: "echo: verified" }] },
      });
      return;
    }
    if (url.pathname === "/api/zaru-memory" && req.method === "GET") {
      // Zaru Web's User Memory endpoint (src/clients/zaru-client.ts).
      sendJson(200, {
        content: "prefers terse answers",
        version: 3,
        updated_at: "2026-09-30T00:00:00Z",
      });
      return;
    }
    if (
      url.pathname === `/v1/executions/${EXECUTION_ID}/events` &&
      req.method === "GET"
    ) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("event: step\ndata: one\n\n");
      // The second event is written only after the test has read the first
      // through the Worker, so a Worker that buffered the whole body would
      // never deliver the first and the test would time out.
      await new Promise<void>((resolve) => {
        releaseSecondEvent = resolve;
      });
      res.end("event: step\ndata: two\n\n");
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
    .setSubject("worker-test-user")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
}

async function mcp(body: unknown, token?: string) {
  return worker.fetch("/mcp/v1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
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
  releaseSecondEvent();
  await worker?.stop();
  await new Promise<void>((resolve) => stub?.close(() => resolve()));
});

test("worker: GET /health answers 200 {status: ok} with a request id", async () => {
  const res = await worker.fetch("/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
  assert.ok(res.headers.get("x-request-id"));
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("worker: /mcp/v1 without a token is refused 401", async () => {
  const res = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /Missing x-zaru-user-token/);
});

test("worker: tools/list through Streamable HTTP returns the upstream's tools and Zaru's", async () => {
  const res = await mcp(
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    await userToken(),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    result: { tools: Array<{ name: string }> };
  };
  const names = body.result.tools.map((t) => t.name);
  assert.ok(names.includes(STUB_TOOL), `tools: ${names.join(", ")}`);
  assert.ok(names.includes("zaru.init"), `tools: ${names.join(", ")}`);
});

test("worker: tools/call signs its SEAL envelope with Ed25519 under nodejs_compat, and the signature verifies", async () => {
  const res = await mcp(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: STUB_TOOL, arguments: {} },
    },
    await userToken(),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  assert.equal(body.result.content[0]?.text, "echo: verified");
  // A raw Ed25519 public key is 32 bytes; the stub verified every envelope.
  assert.equal(seal.publicKeyRaw?.length, 32);
  assert.ok(seal.verified.length >= 1);
  assert.ok(seal.verified.every((ok) => ok));
});

test("worker: zaru.memory.get reaches Zaru Web through ZARU_CLIENT_URL", async () => {
  const res = await mcp(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "zaru.memory.get", arguments: {} },
    },
    await userToken(),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  assert.equal(body.result.isError, false, body.result.content[0]?.text);
  assert.match(body.result.content[0]?.text ?? "", /prefers terse answers/);
});

test("worker: the execution SSE proxy streams each event as it arrives", async () => {
  const res = await worker.fetch(
    `/proxy/v1/executions/${EXECUTION_ID}/stream`,
    { headers: { Authorization: `Bearer ${await userToken()}` } },
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes("data: one\n\n")) {
    const { done, value } = await reader.read();
    assert.equal(done, false, "the stream ended before its first event");
    seen += decoder.decode(value, { stream: true });
  }
  assert.ok(!seen.includes("data: two"));
  releaseSecondEvent();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
  }
  assert.equal(seen, "event: step\ndata: one\n\nevent: step\ndata: two\n\n");
});

test("worker: the execution SSE proxy refuses an id that is not a UUID with 400", async () => {
  const res = await worker.fetch("/proxy/v1/executions/not-a-uuid/stream", {
    headers: { Authorization: `Bearer ${await userToken()}` },
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "executionId must be a UUID" });
});

test("worker: the legacy SSE transport is not served", async () => {
  const res = await worker.fetch("/mcp/v1/sse", {
    headers: { Authorization: `Bearer ${await userToken()}` },
  });
  assert.equal(res.status, 404);
});
