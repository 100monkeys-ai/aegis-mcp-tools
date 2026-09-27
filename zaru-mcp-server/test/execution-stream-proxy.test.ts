// Regression tests for the execution-stream proxy route
// (GET /proxy/v1/executions/:executionId/stream).
//
// These tests run the real express app from src/app.ts behind the real
// auth middleware (real JWKS verification). A Keycloak JWKS stub and an
// orchestrator stub both listen on loopback. The executionId route param
// is decoded by Express, so `%2f`, `%5c`, `%3f` and `%23` used to reach
// the upstream URL as `/`, `\`, `?` and `#`. That let an authenticated
// caller steer the proxied GET to any orchestrator path.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

interface UpstreamRequest {
  method?: string;
  url?: string;
  authorization?: string;
}

const upstream: UpstreamRequest[] = [];
const servers: http.Server[] = [];

function listen(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    );
  });
}

let appPort = 0;
let token = "";

const VALID_ID = "3f2b8c1e-9d4a-4e6b-8a7f-0c1d2e3f4a5b";

before(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const kcPort = await listen((req, res) => {
    if (req.url === "/realms/zaru-consumer/protocol/openid-connect/certs") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const orchestratorPort = await listen((req, res) => {
    upstream.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
    });
    if (req.url === `/v1/executions/${VALID_ID}/events`) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: legit-event\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ reached: req.url }));
  });

  // auth.ts and the orchestrator client read these at import time.
  process.env.JWKS_URI = `http://127.0.0.1:${kcPort}/realms/zaru-consumer/protocol/openid-connect/certs`;
  process.env.AEGIS_ORCHESTRATOR_URL = `http://127.0.0.1:${orchestratorPort}`;
  delete process.env.BYPASS_AUTH;

  const { app } = await import("../src/app.js");
  appPort = await new Promise<number>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    );
    servers.push(server);
  });

  token = await new SignJWT({ zaru_tier: "free", tenant_id: "u-caller" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(`http://127.0.0.1:${kcPort}/realms/zaru-consumer`)
    .setSubject("caller")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
});

after(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});

// Sends the path exactly as given. fetch() would normalise it first, and
// a real attacker's client does not.
function rawGet(
  path: string,
): Promise<{ status: number; contentType?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: appPort,
        method: "GET",
        path,
        headers: { authorization: `Bearer ${token}` },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: res.headers["content-type"],
            body,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("a UUID execution id streams the orchestrator's events under the caller's own token", async () => {
  upstream.length = 0;
  const res = await rawGet(`/proxy/v1/executions/${VALID_ID}/stream`);

  assert.equal(res.status, 200);
  assert.match(res.contentType ?? "", /^text\/event-stream/);
  assert.equal(res.body, "data: legit-event\n\n");
  assert.deepEqual(upstream, [
    {
      method: "GET",
      url: `/v1/executions/${VALID_ID}/events`,
      authorization: `Bearer ${token}`,
    },
  ]);
});

const HOSTILE_IDS: Array<[string, string]> = [
  ["%2f traversal with %3f", "..%2f..%2fv1%2fadmin%2frate-limits%2fusage%3f"],
  ["%2F traversal", "..%2F..%2Fv1%2Fcredentials%3F"],
  ["%2e%2e traversal", "%2e%2e%2f%2e%2e%2fv1%2fsecrets%3f"],
  ["%5c backslash traversal", "..%5c..%5cv1%5ccredentials%3f"],
  ["%3f query injection", "abc%3fforeign=1"],
  ["%23 fragment truncation", "abc%23"],
  ["%23 with traversal", "..%2f..%2fv1%2fvolumes%23"],
  ["%252f double encoding", "..%252f..%252fv1%252fcredentials%253f"],
  ["plain non-UUID", "exec-abc"],
  ["UUID with a trailing path", `${VALID_ID}%2f..%2f..%2fcredentials`],
];

for (const [label, segment] of HOSTILE_IDS) {
  test(`execution id rejected with 400 and no upstream request: ${label}`, async () => {
    upstream.length = 0;
    const res = await rawGet(`/proxy/v1/executions/${segment}/stream`);

    assert.equal(
      upstream.length,
      0,
      `the proxy sent ${upstream.length} upstream request(s) for executionId ${JSON.stringify(segment)}: ${JSON.stringify(upstream.map((u) => u.url))}`,
    );
    assert.equal(
      res.status,
      400,
      `expected 400 for executionId ${JSON.stringify(segment)}, got ${res.status} ${res.body}`,
    );
  });
}
