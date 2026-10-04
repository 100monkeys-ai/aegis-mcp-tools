// The tests of the operator escalation (Zaru ADR-0050 D3 to D6) through an
// entrypoint, and a loopback stub of the orchestrator, shared by
// operator-escalation.test.ts (the container's Express app) and
// operator-escalation.worker.test.ts (the Workers entrypoint in workerd).
//
// The stub answers as aegis-orchestrator 8e6e5d71 does (AEGIS ADR-129 D14 and
// its Update U7): `POST /v1/api-keys/validate` answers ESCALATING_KEY, a key
// with no stored role, with `aegis_role` "aegis:operator" and
// `operator_escalation: { expires_at }` while the stub holds an escalation
// for it, and with `aegis_role` null otherwise; ROLE_KEY, a key created from
// an operator identity, always carries its stored "aegis:operator" and never
// an escalation. Tool discovery answers by the security context it is asked
// for, so the list shows which context the server asked for (the server
// caches a list per context for 5 s, so the list, not the count of
// discovery requests, is what the tests read).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

export const ESCALATING_KEY = "aegis_operator_consumer_key";
export const ROLE_KEY = "aegis_role_bearing_key";
export const CONSUMER_SUB = "5a1e0000-consumer";
export const HOME_TENANT = "u-5a1e0000-consumer";
export const STUB_TOOL = "aegis.stub.echo";
/** A tool the stub lists only for the operator context. */
export const OPERATOR_ONLY_TOOL = "aegis.system.config";
export const OPERATOR_CONTEXT = "aegis-system-operator";

export interface EscalationStub {
  url: string;
  /** The security context of every tool discovery request, in order. */
  discovered: string[];
  /** The security_context of every attest body, in order. */
  attested: string[];
  /** Whether the stub holds an escalation for ESCALATING_KEY. */
  escalated: boolean;
  /** Its expires_at while it holds one. */
  expiresAt: string;
  /** Keycloak paths the stub was asked for (its JWKS for both realms). */
  keycloakRequests: string[];
  /** Sign a JWT as the realm `realm` of the stub's Keycloak would. */
  signJwt(realm: string, claims: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

export async function startEscalationStub(): Promise<EscalationStub> {
  // One key pair serves as both realms' signing key: what is tested is
  // which issuer the server trusts, not the keys.
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const state: EscalationStub = {
    url: "",
    discovered: [],
    attested: [],
    escalated: false,
    expiresAt: new Date(Date.now() + 1800_000).toISOString(),
    keycloakRequests: [],
    signJwt: (realm, claims) => signAs(privateKey, `${state.url}/realms/${realm}`, claims),
    close: async () => undefined,
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const token = bearer(req);

    if (url.pathname.startsWith("/realms/")) {
      state.keycloakRequests.push(url.pathname);
      if (url.pathname.endsWith("/protocol/openid-connect/certs")) {
        sendJson(200, { keys: [jwk] });
        return;
      }
    }

    if (url.pathname === "/v1/api-keys/validate" && req.method === "POST") {
      if (token === ESCALATING_KEY) {
        sendJson(200, {
          user_id: CONSUMER_SUB,
          tenant_id: HOME_TENANT,
          aegis_role: state.escalated ? "aegis:operator" : null,
          scopes: [],
          zaru_tier: "pro",
          ...(state.escalated
            ? { operator_escalation: { expires_at: state.expiresAt } }
            : {}),
        });
        return;
      }
      if (token === ROLE_KEY) {
        sendJson(200, {
          user_id: "9c3d0000-system",
          tenant_id: HOME_TENANT,
          aegis_role: "aegis:operator",
          scopes: [],
          zaru_tier: null,
        });
        return;
      }
      sendJson(401, { error: "Invalid or expired API key" });
      return;
    }
    if (url.pathname === "/v1/seal/tools" && req.method === "GET") {
      const context = String(req.headers["x-zaru-security-context"]);
      state.discovered.push(context);
      const tool = (name: string) => ({
        name,
        description: `${name}, from the stub orchestrator`,
        inputSchema: { type: "object", properties: {} },
      });
      sendJson(200, {
        tools:
          context === OPERATOR_CONTEXT
            ? [tool(STUB_TOOL), tool(OPERATOR_ONLY_TOOL)]
            : [tool(STUB_TOOL)],
      });
      return;
    }
    if (url.pathname === "/v1/seal/attest" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as {
        security_context?: unknown;
      };
      state.attested.push(String(body.security_context));
      sendJson(200, { security_token: `stub-token-${state.attested.length}` });
      return;
    }
    if (url.pathname === "/v1/seal/invoke" && req.method === "POST") {
      const envelope = JSON.parse(await readBody(req)) as {
        payload: { id: unknown; params?: { name?: unknown } };
      };
      sendJson(200, {
        jsonrpc: "2.0",
        id: envelope.payload.id,
        result: {
          content: [
            {
              type: "text",
              text: `invoked: ${String(envelope.payload.params?.name)}`,
            },
          ],
        },
      });
      return;
    }
    sendJson(404, { error: "stub: no such route" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${port}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}

/** POSTs one JSON-RPC message to /mcp/v1 of the entrypoint under test. */
export type McpPost = (
  body: unknown,
  headers?: Record<string, string>,
) => Promise<Response>;

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

let nextId = 1000;

async function rpc(
  post: McpPost,
  token: string,
  method: string,
  params: unknown,
): Promise<{ result?: unknown; error?: { message: string } }> {
  const res = await post(
    { jsonrpc: "2.0", id: nextId++, method, params },
    {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
  );
  assert.equal(res.status, 200, `HTTP ${res.status}: ${await res.clone().text()}`);
  return (await res.json()) as { result?: unknown; error?: { message: string } };
}

type ListedTool = {
  name: string;
  inputSchema: { properties?: Record<string, { enum?: string[] }> };
};

async function listTools(post: McpPost, token: string): Promise<ListedTool[]> {
  const answer = await rpc(post, token, "tools/list", {});
  return (answer.result as { tools: ListedTool[] }).tools;
}

async function callTool(
  post: McpPost,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const answer = await rpc(post, token, "tools/call", { name, arguments: args });
  assert.ok(answer.result, `no result: ${JSON.stringify(answer)}`);
  return answer.result as ToolResult;
}

function modeEnum(tools: ListedTool[]): string[] {
  const init = tools.find((t) => t.name === "zaru.init");
  assert.ok(init, "zaru.init is listed");
  return init.inputSchema.properties?.mode?.enum ?? [];
}

function names(tools: ListedTool[]): string[] {
  return tools.map((t) => t.name);
}

export interface EscalationTestContext {
  post: McpPost;
  stub: EscalationStub;
}

function signAs(
  key: SigningKey,
  issuer: string,
  claims: Record<string, unknown>,
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(issuer)
    .setSubject(String(claims.sub ?? "anyone"))
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
}

/**
 * Registers the tests of Zaru ADR-0050 D5 and D6 against one entrypoint.
 * `context` is read when each test runs, after the file's `before` has
 * started the stub and the entrypoint.
 */
export function registerOperatorSurfaceTests(
  label: string,
  context: () => EscalationTestContext,
): void {
  test(`${label}: a key holding an escalation is served the operator context and the operator mode (D5)`, async () => {
    const { post, stub } = context();
    stub.escalated = true;
    try {
      const tools = await listTools(post, ESCALATING_KEY);
      assert.ok(names(tools).includes(OPERATOR_ONLY_TOOL), names(tools).join(", "));
      assert.ok(modeEnum(tools).includes("operator"), modeEnum(tools).join(", "));

      const init = await callTool(post, ESCALATING_KEY, "zaru.init", {
        mode: "operator",
      });
      assert.notEqual(init.isError, true, init.content[0]?.text);
      assert.equal(JSON.parse(init.content[0]!.text).mode, "operator");

      const call = await callTool(post, ESCALATING_KEY, STUB_TOOL, {});
      assert.notEqual(call.isError, true, call.content[0]?.text);
      assert.equal(stub.attested.at(-1), OPERATOR_CONTEXT);
    } finally {
      stub.escalated = false;
    }
  });

  test(`${label}: the same key once validate omits operator_escalation is served its ordinary surface (D5)`, async () => {
    const { post, stub } = context();
    stub.escalated = true;
    const escalated = await listTools(post, ESCALATING_KEY);
    assert.ok(names(escalated).includes(OPERATOR_ONLY_TOOL));

    stub.escalated = false;
    const tools = await listTools(post, ESCALATING_KEY);
    assert.ok(!names(tools).includes(OPERATOR_ONLY_TOOL), names(tools).join(", "));
    assert.ok(!modeEnum(tools).includes("operator"), modeEnum(tools).join(", "));

    const init = await callTool(post, ESCALATING_KEY, "zaru.init", {
      mode: "operator",
    });
    assert.equal(init.isError, true, init.content[0]?.text);

    const call = await callTool(post, ESCALATING_KEY, STUB_TOOL, {});
    assert.notEqual(call.isError, true, call.content[0]?.text);
    assert.equal(stub.attested.at(-1), "zaru-pro");
  });

  test(`${label}: a key with a stored role is served the consumer context and no operator mode (D6)`, async () => {
    const { post, stub } = context();
    const tools = await listTools(post, ROLE_KEY);
    assert.ok(!names(tools).includes(OPERATOR_ONLY_TOOL), names(tools).join(", "));
    assert.ok(!modeEnum(tools).includes("operator"), modeEnum(tools).join(", "));
    const init = await callTool(post, ROLE_KEY, "zaru.init", { mode: "operator" });
    assert.equal(init.isError, true, init.content[0]?.text);
  });

  test(`${label}: an aegis-system JWT, signed by that realm, is refused 401 (D6)`, async () => {
    const { post, stub } = context();
    for (const claims of [
      { sub: "operator-1", aegis_role: "admin" },
      { sub: "operator-2", aegis_role: "operator" },
      { sub: "service-1" },
    ]) {
      const token = await stub.signJwt("aegis-system", claims);
      const res = await post(
        { jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} },
        {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
        },
      );
      assert.equal(res.status, 401, `${JSON.stringify(claims)}: ${await res.text()}`);
    }
  });

  test(`${label}: a consumer-realm JWT signed the same way is still served (D6 refuses only the aegis-system realm)`, async () => {
    const { post, stub } = context();
    const token = await stub.signJwt("zaru-consumer", {
      sub: "consumer-1",
      zaru_tier: "pro",
    });
    const res = await post(
      { jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} },
      {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
    );
    assert.equal(res.status, 200, await res.text());
  });
}
