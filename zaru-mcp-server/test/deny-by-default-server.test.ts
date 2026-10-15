// Zaru ADR-0071 (Deny by default) D3's API key and Trigger 2 (a) to (d), the
// Zaru MCP server's half:
//
// (a) a key carrying a profile forwards it as `_meta.profile` on every call
//     and listing (`GET /v1/seal/tools` carries it beside the credential);
// (b) a key with none, and no choice, is listed no connection family's tool;
// (c) `x-zaru-turn` changes neither;
// (d) the mode text teaches a key with no profile that it reaches none of the
//     person's connections, and the facing text names no decision record.
//
// The fake orchestrator answers `GET /v1/seal/tools` as aegis-orchestrator
// does before `deny-by-default-orchestrator` lands: the credential's person's
// whole set (every family they connected, their own server's tools
// included), whatever profile the request names. So (b) holds only if the
// server itself lists none of those families for a key with no profile.
//
// ASSUMPTION (named in the arc's READY): the orchestrator's key validation
// answer carries the key's profile as `profile` (a profile id, or null), and
// the listing request carries the profile in the `X-Zaru-Profile` header.
// Both are the orchestrator half's to fix; until then this is the shape built.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type * as StreamableHttp from "../src/mcp/streamable-http.js";
import { OrchestratorClient } from "../src/mcp/orchestrator-client.js";
import {
  authenticateZaruRequest,
  type ApiKeyIdentity,
  type ZaruUser,
} from "../src/middleware/auth.js";

// zaru.init reads the person's memory from Zaru Web; the server module builds
// that client when it loads, so a local memory route answering an empty memory
// is named before the module is imported, and the test never waits on a
// network it does not own.
const memory = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ content: "" }));
});
await new Promise<void>((resolve) => memory.listen(0, "127.0.0.1", resolve));
process.env.ZARU_CLIENT_URL = `http://127.0.0.1:${(memory.address() as AddressInfo).port}`;
test.after(() => memory.close());
const streamableHttp: typeof StreamableHttp = await import("../src/mcp/streamable-http.js");

const KEY = "aegis_deny_by_default_key";
const KEY_PROFILE = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
const HEADER_PROFILE = "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b";

const RECORD_REFERENCE =
  /ADR-[0-9]|CD-[0-9]|ADR [0-9]|[Dd]ecision record|security audit 0|audit 0[0-9][0-9]|§[0-9]/;

/** The words the mode text teaches a key with no profile. */
const NO_PROFILE_TEACHING =
  "reaches none of the person's connections until a profile is chosen for it on the API keys page in Zaru Web";

type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };
const tool = (name: string): Tool => ({
  name,
  description: `${name}, from the fake orchestrator`,
  inputSchema: { type: "object", properties: {} },
});

/** The person's whole set, as today's orchestrator answers it for a key. */
const PERSONS_SET: Tool[] = [
  tool("web.search"),
  tool("aegis.task.list"),
  tool("mail.list"),
  tool("calendar.list"),
  tool("github.list_issues"),
  tool("nuclear-notes.search"),
  tool("weather-station.read"),
];
const CONNECTION_TOOLS = [
  "mail.list",
  "calendar.list",
  "github.list_issues",
  "nuclear-notes.search",
  "weather-station.read",
];

interface Seen {
  discoveries: Array<Record<string, string>>;
  invoked: Array<{ method: string; params: Record<string, unknown> }>;
  contextListings: Array<Record<string, unknown>>;
}

function fakeOrchestrator(seen: Seen) {
  return async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/v1/seal/tools") {
      seen.discoveries.push({ ...((init?.headers ?? {}) as Record<string, string>) });
      return json(200, { tools: PERSONS_SET });
    }
    if (url.pathname === "/v1/seal/attest") return json(200, { security_token: "fake-security-token" });
    if (url.pathname === "/v1/seal/invoke") {
      const envelope = JSON.parse(String(init?.body)) as {
        payload: { id: unknown; method: string; params: Record<string, unknown> };
      };
      seen.invoked.push(envelope.payload);
      return json(200, { jsonrpc: "2.0", id: envelope.payload.id, result: { content: [{ type: "text", text: "ok" }] } });
    }
    if (url.pathname === "/v1/seal/context-tools") {
      const envelope = JSON.parse(String(init?.body)) as { payload: { params: Record<string, unknown> } };
      seen.contextListings.push(envelope.payload.params);
      return json(200, { tools: [] });
    }
    if (url.pathname.startsWith("/v1/profiles/")) return json(404, { error: "Not found" });
    return json(404, { error: "fake: no such route" });
  };
}

function setUp() {
  const seen: Seen = { discoveries: [], invoked: [], contextListings: [] };
  const orchestrator = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    cacheTtlMs: 60_000,
    fetchImpl: fakeOrchestrator(seen),
  });
  return { seen, orchestrator };
}

/** The user the auth middleware makes of KEY, its validation answering `over`. */
// `profile` is the assumed field of the validation answer (see above).
async function keyUser(over: Partial<ApiKeyIdentity> & { profile?: string | null } = {}): Promise<ZaruUser> {
  const result = await authenticateZaruRequest(
    { authorization: `Bearer ${KEY}` },
    {},
    async () => {
      throw new Error("no JWT in this test");
    },
    async () => ({
      user_id: "user-key",
      tenant_id: "tenant-key",
      aegis_role: null,
      zaru_tier: "pro",
      scopes: [],
      ...over,
    }) as ApiKeyIdentity,
  );
  assert.ok("user" in result, `the key was refused: ${JSON.stringify(result)}`);
  return result.user;
}

const jwtUser: ZaruUser = {
  userId: "user-web",
  tier: "pro",
  securityContext: "zaru-pro",
  token: "header.payload.signature",
  isOperator: false,
  tenantId: "tenant-web",
};

async function connected(
  user: ZaruUser,
  orchestrator: OrchestratorClient,
  context: StreamableHttp.McpRequestContext,
) {
  const server = streamableHttp.createMcpServerForUser(user, new Set(), "deny-by-default", orchestrator, context);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "deny-by-default", version: "0" });
  await client.connect(clientSide);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

const namesOf = (tools: Array<{ name: string }>) => tools.map((t) => t.name);

async function forwardsKeyProfile(zaruTurn: boolean): Promise<string[]> {
  const complaints: string[] = [];
  const user = await keyUser({ profile: KEY_PROFILE });
  const { seen, orchestrator } = setUp();
  const session = await connected(user, orchestrator, { zaruTurn });
  try {
    const names = namesOf((await session.client.listTools()).tools);
    await session.client.callTool({ name: "web.search", arguments: { query: "q" } });
    await session.client.callTool({ name: "mail.list", arguments: {} });
    await session.client.callTool({ name: "zaru.script.run", arguments: { id: "script-1" } });
    for (const d of seen.discoveries) {
      if (d["X-Zaru-Profile"] !== KEY_PROFILE) {
        complaints.push(`a listing did not carry the key's profile beside the credential: ${JSON.stringify(d)}`);
      }
      if (d.Authorization !== `Bearer ${KEY}`) complaints.push(`a listing did not carry the credential: ${JSON.stringify(d)}`);
    }
    if (seen.discoveries.length === 0) complaints.push("no listing was asked for");
    const calls = seen.invoked.filter((p) => p.method === "tools/call");
    if (calls.length < 3) complaints.push(`expected at least three forwarded calls, got ${calls.length}`);
    for (const call of calls) {
      const meta = call.params._meta as Record<string, unknown> | undefined;
      if (meta?.profile !== KEY_PROFILE || "contexts" in (meta ?? {})) {
        complaints.push(`${String(call.params.name)} carried _meta ${JSON.stringify(meta)}, not the key's profile alone`);
      }
      const args = call.params.arguments as Record<string, unknown> | undefined;
      if (args && "profile" in args) complaints.push(`${String(call.params.name)} carried the profile in its arguments`);
    }
    // A key on a profile is listed what the orchestrator answers for it.
    if (!names.includes("mail.list")) complaints.push(`the key on a profile lost its listing: ${names.join(", ")}`);
  } finally {
    await session.close();
  }
  return complaints;
}

async function listsNoConnectionFamily(zaruTurn: boolean): Promise<string[]> {
  const complaints: string[] = [];
  const user = await keyUser({ profile: null });
  const { seen, orchestrator } = setUp();
  const session = await connected(user, orchestrator, { zaruTurn });
  try {
    const names = namesOf((await session.client.listTools()).tools);
    const leaked = names.filter((n) => CONNECTION_TOOLS.includes(n));
    if (leaked.length > 0) complaints.push(`a key with no profile was listed ${leaked.join(", ")}`);
    for (const kept of ["web.search", "aegis.task.list", "zaru.init", "zaru.connection.needed"]) {
      if (!names.includes(kept)) complaints.push(`a key with no profile lost ${kept}: ${names.join(", ")}`);
    }
    for (const d of seen.discoveries) {
      if ("X-Zaru-Profile" in d) complaints.push(`a key with no profile sent a profile: ${JSON.stringify(d)}`);
    }
    if (seen.contextListings.length > 0) complaints.push("a key with no choice asked for a context listing");
    await session.client.callTool({ name: "web.search", arguments: {} });
    const call = seen.invoked.find((p) => p.method === "tools/call");
    if (call && "_meta" in call.params) complaints.push(`a key with no profile carried _meta ${JSON.stringify(call.params._meta)}`);
  } finally {
    await session.close();
  }
  return complaints;
}

test("Trigger 2 (a): a key carrying a profile forwards it as _meta.profile on every call and on the listing", async () => {
  assert.deepEqual(await forwardsKeyProfile(false), []);
});

test("Trigger 2 (a): the key's profile is read from its validation answer, escalated or not, and fills calls made outside the Streamable HTTP server", async () => {
  const complaints: string[] = [];
  const plain = await keyUser({ profile: KEY_PROFILE });
  const escalated = await keyUser({
    profile: KEY_PROFILE,
    aegis_role: "aegis:operator",
    operator_escalation: { expires_at: new Date(Date.now() + 600_000).toISOString() },
  });
  const none = await keyUser({});
  const keyProfileOf = (user: ZaruUser) => (user as { keyProfile?: unknown }).keyProfile;
  if (keyProfileOf(plain) !== KEY_PROFILE) complaints.push(`plain key: keyProfile ${String(keyProfileOf(plain))}`);
  if (keyProfileOf(escalated) !== KEY_PROFILE || !escalated.isOperator) {
    complaints.push(`escalated key: keyProfile ${String(keyProfileOf(escalated))}, isOperator ${escalated.isOperator}`);
  }
  if (keyProfileOf(none) !== undefined) complaints.push(`a key with no profile field: keyProfile ${String(keyProfileOf(none))}`);
  // The SSE and stdio paths call the client with no request context.
  const { seen, orchestrator } = setUp();
  await orchestrator.listTools(plain);
  await orchestrator.invokeTool(plain, "web.search", {}, 1);
  if (seen.discoveries[0]?.["X-Zaru-Profile"] !== KEY_PROFILE) {
    complaints.push(`a bare listing did not carry the key's profile: ${JSON.stringify(seen.discoveries[0])}`);
  }
  const meta = seen.invoked.find((p) => p.method === "tools/call")?.params._meta;
  if (JSON.stringify(meta) !== JSON.stringify({ profile: KEY_PROFILE })) {
    complaints.push(`a bare call carried _meta ${JSON.stringify(meta)}`);
  }
  assert.deepEqual(complaints, []);
});

test("Trigger 2 (a): a profile the request names wins over the key's, and a binding the request chooses sends no key profile", async () => {
  const complaints: string[] = [];
  const user = await keyUser({ profile: KEY_PROFILE });
  {
    const { seen, orchestrator } = setUp();
    const session = await connected(user, orchestrator, { profile: HEADER_PROFILE });
    try {
      await session.client.listTools();
      await session.client.callTool({ name: "web.search", arguments: {} });
    } finally {
      await session.close();
    }
    const meta = seen.invoked.find((p) => p.method === "tools/call")?.params._meta;
    if (JSON.stringify(meta) !== JSON.stringify({ profile: HEADER_PROFILE })) complaints.push(`named profile: _meta ${JSON.stringify(meta)}`);
    if (seen.discoveries.some((d) => d["X-Zaru-Profile"] !== HEADER_PROFILE)) {
      complaints.push(`named profile: listing ${JSON.stringify(seen.discoveries)}`);
    }
  }
  {
    const contexts = { github: "0d3f6a2e-1b2c-4d5e-8f90-a1b2c3d4e5f6" };
    const { seen, orchestrator } = setUp();
    const session = await connected(user, orchestrator, { contexts });
    try {
      await session.client.callTool({ name: "github.list_issues", arguments: {} });
    } finally {
      await session.close();
    }
    const meta = seen.invoked.find((p) => p.method === "tools/call")?.params._meta;
    if (JSON.stringify(meta) !== JSON.stringify({ contexts })) complaints.push(`chosen binding: _meta ${JSON.stringify(meta)}`);
  }
  assert.deepEqual(complaints, []);
});

test("Trigger 2 (b): a key with no profile and no choice is listed no tool of any connection family", async () => {
  assert.deepEqual(await listsNoConnectionFamily(false), []);
});

test("Trigger 2 (b): an escalated key with no profile is listed the operator's tools and no connection family's", async () => {
  const user = await keyUser({
    aegis_role: "aegis:operator",
    operator_escalation: { expires_at: new Date(Date.now() + 600_000).toISOString() },
  });
  const { orchestrator } = setUp();
  const session = await connected(user, orchestrator, {});
  try {
    const names = namesOf((await session.client.listTools()).tools);
    assert.deepEqual(names.filter((n) => CONNECTION_TOOLS.includes(n)), [], `listed: ${names.join(", ")}`);
    assert.ok(names.includes("aegis.task.list"), `listed: ${names.join(", ")}`);
  } finally {
    await session.close();
  }
});

test("Trigger 2 (b): the person's own chat turn (a session token, not a key) keeps the listing as the orchestrator answers it", async () => {
  const { orchestrator } = setUp();
  const session = await connected(jwtUser, orchestrator, { zaruTurn: true });
  try {
    const names = namesOf((await session.client.listTools()).tools);
    assert.deepEqual(CONNECTION_TOOLS.filter((n) => !names.includes(n)), [], `listed: ${names.join(", ")}`);
  } finally {
    await session.close();
  }
});

test("Trigger 2 (c): x-zaru-turn changes neither the key's forwarded profile nor a profileless key's listing", async () => {
  const complaints = [
    ...(await forwardsKeyProfile(true)).map((c) => `with x-zaru-turn, key on a profile: ${c}`),
    ...(await listsNoConnectionFamily(true)).map((c) => `with x-zaru-turn, key with none: ${c}`),
  ];
  assert.deepEqual(complaints, []);
});

async function initPrompt(user: ZaruUser, context: StreamableHttp.McpRequestContext, mode: string): Promise<string> {
  const { orchestrator } = setUp();
  const session = await connected(user, orchestrator, context);
  try {
    const result = (await session.client.callTool({ name: "zaru.init", arguments: { mode } })) as {
      content: Array<{ type: string; text: string }>;
    };
    const body = JSON.parse(result.content[0]!.text) as { system_prompt?: string };
    return body.system_prompt ?? "";
  } finally {
    await session.close();
  }
}

test("Trigger 2 (d): every mode teaches a key with no profile, in a sentence naming no decision record, that it reaches none of the person's connections", async () => {
  const complaints: string[] = [];
  const noProfile = await keyUser({ profile: null });
  const onProfile = await keyUser({ profile: KEY_PROFILE });
  for (const mode of ["chat", "agentic", "workflow", "execute"]) {
    for (const zaruTurn of [false, true]) {
      const prompt = await initPrompt(noProfile, { zaruTurn }, mode);
      const taught = prompt.split("\n").filter((line) => line.includes(NO_PROFILE_TEACHING));
      if (taught.length !== 1) complaints.push(`${mode} (x-zaru-turn ${zaruTurn}): taught ${taught.length} times`);
      for (const line of taught) {
        if (RECORD_REFERENCE.test(line)) complaints.push(`${mode}: the teaching names a record: ${line}`);
      }
    }
    if ((await initPrompt(onProfile, {}, mode)).includes(NO_PROFILE_TEACHING)) {
      complaints.push(`${mode}: a key on a profile was taught it has none`);
    }
    if ((await initPrompt(jwtUser, { zaruTurn: true }, mode)).includes(NO_PROFILE_TEACHING)) {
      complaints.push(`${mode}: the person's own turn was taught the key sentence`);
    }
    const chose = await initPrompt(noProfile, { contexts: { github: "0d3f6a2e-1b2c-4d5e-8f90-a1b2c3d4e5f6" } }, mode);
    if (chose.includes(NO_PROFILE_TEACHING)) complaints.push(`${mode}: a key that chose a binding was taught it has none`);
  }
  assert.deepEqual(complaints, []);
});
