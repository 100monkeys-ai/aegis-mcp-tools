// Regression tests for issuer trust in JWT verification.
//
// These tests run the real express app from src/app.ts behind the real
// auth middleware, with a Keycloak stub on loopback that counts every
// request. verifyJwtWithJwks used to read `iss` from the unverified token
// and check only that it started with `<keycloak host>/realms/`. For each
// new issuer it cached a remote JWKS set in an unbounded module-level Map,
// and jose then fetched `<iss>/protocol/openid-connect/certs`. So an
// unauthenticated caller could grow memory without limit and make the
// server send a GET to a path of its choosing on the Keycloak host.
// Trust is now an exact set of issuers fixed at startup from
// configuration.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const VALID_ID = "3f2b8c1e-9d4a-4e6b-8a7f-0c1d2e3f4a5b";
const FORGED_ISSUER_COUNT = 200;

const keycloakRequests: string[] = [];
const servers: http.Server[] = [];
let keycloakBase = "";
let appPort = 0;
let tenantKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let jwksKeySetCount: () => number;

function listen(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    );
  });
}

before(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  tenantKey = privateKey;
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };

  const kcPort = await listen((req, res) => {
    keycloakRequests.push(req.url ?? "");
    if (req.url === "/realms/tenant-acme/protocol/openid-connect/certs") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  keycloakBase = `http://127.0.0.1:${kcPort}`;

  const orchestratorPort = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: ok\n\n");
  });

  // auth.ts reads these at import time.
  process.env.JWKS_URI = `${keycloakBase}/realms/zaru-consumer/protocol/openid-connect/certs`;
  process.env.KEYCLOAK_SYSTEM_ISSUER = `${keycloakBase}/realms/aegis-system`;
  process.env.KEYCLOAK_TRUSTED_ISSUERS = ` ${keycloakBase}/realms/tenant-acme , `;
  process.env.AEGIS_ORCHESTRATOR_URL = `http://127.0.0.1:${orchestratorPort}`;
  delete process.env.BYPASS_AUTH;

  ({ jwksKeySetCount } = await import("../src/middleware/auth.js"));
  const { app } = await import("../src/app.js");
  appPort = await new Promise<number>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    );
    servers.push(server);
  });
});

after(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// A token nobody signed. The signature is junk, and the issuer is a realm
// under the Keycloak host that the server was never configured to trust.
function unsignedToken(iss: string): string {
  return [
    b64url({ alg: "RS256", typ: "JWT", kid: "k1" }),
    b64url({ iss, sub: "anyone", exp: Math.floor(Date.now() / 1000) + 600 }),
    Buffer.from("not-a-signature").toString("base64url"),
  ].join(".");
}

function get(authorization: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: appPort,
        method: "GET",
        path: `/proxy/v1/executions/${VALID_ID}/stream`,
        headers: { authorization },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("tokens from unconfigured issuers are refused before any key set is allocated or fetched", async () => {
  const keySetsBefore = jwksKeySetCount();
  keycloakRequests.length = 0;

  const statuses = new Map<number, number>();
  for (let i = 0; i < FORGED_ISSUER_COUNT; i++) {
    const res = await get(
      `Bearer ${unsignedToken(`${keycloakBase}/realms/forged-${i}`)}`,
    );
    statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
  }

  const keySetsAfter = jwksKeySetCount();
  const measured = `${FORGED_ISSUER_COUNT} forged issuers -> Keycloak received ${keycloakRequests.length} request(s); key sets held ${keySetsBefore} before, ${keySetsAfter} after; statuses ${JSON.stringify([...statuses])}`;

  assert.deepEqual([...statuses], [[401, FORGED_ISSUER_COUNT]], measured);
  assert.equal(keycloakRequests.length, 0, measured);
  assert.equal(keySetsAfter, keySetsBefore, measured);
  assert.equal(keySetsAfter, 3, measured);
});

test("an issuer that only shares the realm prefix is refused without a request to Keycloak", async () => {
  keycloakRequests.length = 0;
  for (const iss of [
    `${keycloakBase}/realms/tenant-acme/../../admin/realms`,
    `${keycloakBase}/realms/tenant-acme#`,
    `${keycloakBase}/realms/tenant-acme?x=`,
    `${keycloakBase}/realms/tenant-acme/`,
  ]) {
    const res = await get(`Bearer ${unsignedToken(iss)}`);
    assert.equal(res.status, 401, `expected 401 for iss ${iss}`);
  }
  assert.deepEqual(keycloakRequests, []);
});

test("a token signed by a realm listed in KEYCLOAK_TRUSTED_ISSUERS is accepted", async () => {
  const token = await new SignJWT({
    zaru_tier: "business",
    tenant_id: "tenant-acme",
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(`${keycloakBase}/realms/tenant-acme`)
    .setSubject("acme-user")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(tenantKey);

  const res = await get(`Bearer ${token}`);

  assert.equal(res.status, 200, res.body);
  assert.equal(res.body, "data: ok\n\n");
});
