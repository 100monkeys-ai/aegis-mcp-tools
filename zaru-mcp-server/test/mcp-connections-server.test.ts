// Zaru ADR-0069 D2 and D7's listing, Trigger 2 (a) to (c): `tools/list`
// answers the presenting person's callable set as the orchestrator's
// `GET /v1/seal/tools` computes it from their credential, with no
// `x-zaru-contexts` needed, cached per person and never per context alone.
//
// The fake orchestrator below answers that route as aegis-orchestrator
// `46d31d61` does (cli/src/daemon/handlers/seal.rs, list_seal_tools_handler):
// with `Authorization: Bearer <credential>` beside `X-Zaru-Security-Context`
// it answers the credential's person's set for that context (the person's
// bound servers' tools included; under an operator escalation the operator
// context's tools with the person's plan set); a credential it does not know
// is answered 401; without a credential it answers the context's static set.
import test from "node:test";
import assert from "node:assert/strict";
import * as streamableHttp from "../src/mcp/streamable-http.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OrchestratorClient } from "../src/mcp/orchestrator-client.js";
import type { ZaruUser } from "../src/middleware/auth.js";

type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };

const tool = (name: string, inputSchema: Record<string, unknown> = { type: "object", properties: {} }): Tool => ({
  name,
  description: `${name}, from the fake orchestrator`,
  inputSchema,
});

// As the orchestrator lists it at 46d31d61: `mailbox` still required there;
// the server passes the schema through unchanged.
const MAIL_LIST = tool("mail.list", {
  type: "object",
  properties: { mailbox: { type: "string", description: "The mailbox to read." } },
  required: ["mailbox"],
});
const WEB_SEARCH = tool("web.search");
const GITHUB_ISSUES = tool("github.list_issues");
const SYSTEM_INFO = tool("aegis.system.info");

/** The context's static set: what the route answers without a credential. */
const STATIC: Record<string, Tool[]> = {
  "zaru-pro": [WEB_SEARCH, MAIL_LIST],
  "aegis-system-operator": [SYSTEM_INFO],
};

/** Each credential's person's set, per context, as the route answers it. */
const PERSONS: Record<string, Record<string, Tool[]>> = {
  "aegis_key_with_mailbox": { "zaru-pro": [WEB_SEARCH, MAIL_LIST] },
  "aegis_key_with_nothing": { "zaru-pro": [WEB_SEARCH] },
  "aegis_key_with_github": { "zaru-pro": [WEB_SEARCH, GITHUB_ISSUES] },
  "aegis_key_escalated": { "aegis-system-operator": [SYSTEM_INFO, WEB_SEARCH, MAIL_LIST] },
};

type Request = { url: string; headers: Record<string, string> };

function fakeOrchestrator(requests: Request[]) {
  return async (input: unknown, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ url: String(input), headers });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (!String(input).endsWith("/v1/seal/tools")) return json(404, { error: "fake: no such route" });
    const context = headers["X-Zaru-Security-Context"] ?? "";
    const authorization = headers.Authorization;
    if (authorization === undefined) return json(200, { tools: STATIC[context] ?? [] });
    const person = PERSONS[authorization.replace(/^Bearer /, "")];
    if (!person) return json(401, { error: "The credential presented could not be authenticated." });
    const set = person[context];
    if (!set) return json(403, { error: "This security context is not one your credential may use." });
    return json(200, { tools: set });
  };
}

const person = (userId: string, token: string, over: Partial<ZaruUser> = {}): ZaruUser => ({
  userId,
  tier: "pro",
  securityContext: "zaru-pro",
  token,
  isOperator: false,
  tenantId: `tenant-${userId}`,
  ...over,
});

async function listed(
  user: ZaruUser,
  orchestrator: OrchestratorClient,
): Promise<Array<{ name: string; inputSchema: unknown }>> {
  // No x-zaru-contexts: the request context carries no choice.
  const server = streamableHttp.createMcpServerForUser(user, new Set(), "listing", orchestrator, {});
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "listing", version: "0" });
  await client.connect(clientSide);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

const namesOf = (tools: Array<{ name: string }>) => tools.map((t) => t.name);

test("Trigger 2 (a): tools/list for two people of one tier answers each their own set, the cache keyed per person", async () => {
  const requests: Request[] = [];
  const orchestrator = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    cacheTtlMs: 60_000,
    fetchImpl: fakeOrchestrator(requests),
  });
  const withMailbox = person("user-a", "aegis_key_with_mailbox");
  const withNothing = person("user-b", "aegis_key_with_nothing");

  const first = await listed(withMailbox, orchestrator);
  const second = await listed(withNothing, orchestrator);
  const firstAgain = await listed(withMailbox, orchestrator);

  const complaints: string[] = [];
  if (!namesOf(first).includes("mail.list")) complaints.push(`the person with a mailbox was not listed mail.list: ${namesOf(first).join(", ")}`);
  if (namesOf(second).includes("mail.list")) complaints.push(`the person with no mailbox was listed mail.list: ${namesOf(second).join(", ")}`);
  if (!namesOf(second).includes("web.search")) complaints.push("the person with no mailbox was not listed web.search");
  if (!namesOf(firstAgain).includes("mail.list")) complaints.push("the first person's second listing lost mail.list");
  // The advertised mail tool's schema is the orchestrator's, unchanged.
  const mail = first.find((t) => t.name === "mail.list");
  if (mail && JSON.stringify(mail.inputSchema) !== JSON.stringify(MAIL_LIST.inputSchema)) {
    complaints.push(`mail.list's schema was changed: ${JSON.stringify(mail.inputSchema)}`);
  }
  const discoveries = requests.filter((r) => r.url.endsWith("/v1/seal/tools"));
  if (discoveries.length !== 2) complaints.push(`expected one discovery per person within the time to live, got ${discoveries.length}`);
  for (const d of discoveries) {
    if (d.headers["X-Zaru-Security-Context"] !== "zaru-pro") complaints.push(`a discovery named context ${d.headers["X-Zaru-Security-Context"]}`);
  }
  const credentials = discoveries.map((d) => d.headers.Authorization);
  if (JSON.stringify(credentials) !== JSON.stringify(["Bearer aegis_key_with_mailbox", "Bearer aegis_key_with_nothing"])) {
    complaints.push(`the discoveries did not carry each person's credential: ${JSON.stringify(credentials)}`);
  }
  assert.deepEqual(complaints, []);
});

test("Trigger 2 (b): a person with a github binding is listed github. tools with no x-zaru-contexts", async () => {
  const requests: Request[] = [];
  const orchestrator = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    cacheTtlMs: 60_000,
    fetchImpl: fakeOrchestrator(requests),
  });
  const names = namesOf(await listed(person("user-g", "aegis_key_with_github"), orchestrator));
  assert.ok(
    names.some((n) => n.startsWith("github.")),
    `no github. tool listed without x-zaru-contexts: ${names.join(", ")}`,
  );
  assert.equal(
    requests.filter((r) => r.url.endsWith("/v1/seal/context-tools")).length,
    0,
    "with no choice no context-tools listing is asked for",
  );
});

test("Trigger 2 (c): an escalated key is listed the operator's tools and the person's set together", async () => {
  const requests: Request[] = [];
  const orchestrator = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    cacheTtlMs: 60_000,
    fetchImpl: fakeOrchestrator(requests),
  });
  const escalated = person("user-op", "aegis_key_escalated", {
    tier: "operator",
    securityContext: "aegis-system-operator",
    isOperator: true,
    operatorEscalation: { expiresAt: new Date(Date.now() + 600_000).toISOString() },
  });
  const names = namesOf(await listed(escalated, orchestrator));
  const missing = ["aegis.system.info", "mail.list", "web.search"].filter((n) => !names.includes(n));
  assert.deepEqual(missing, [], `listed: ${names.join(", ")}`);
});

test("a person listed a tool that their chosen context also lists sees it once", async () => {
  const orchestrator = new OrchestratorClient({
    baseUrl: "http://aegis.test",
    cacheTtlMs: 60_000,
    fetchImpl: fakeOrchestrator([]),
  });
  // The context listing answers a tool the person's set already holds.
  orchestrator.listContextTools = async () => [GITHUB_ISSUES, tool("github.get_me")];
  const user = person("user-g2", "aegis_key_with_github");
  const server = streamableHttp.createMcpServerForUser(user, new Set(), "listing", orchestrator, {
    contexts: { github: "0d3f6a2e-1b2c-4d5e-8f90-a1b2c3d4e5f6" },
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "listing", version: "0" });
  await client.connect(clientSide);
  try {
    const names = namesOf((await client.listTools()).tools);
    assert.deepEqual(names.filter((n) => n === "github.list_issues"), ["github.list_issues"]);
    assert.ok(names.includes("github.get_me"), `the context's other tool is listed: ${names.join(", ")}`);
  } finally {
    await client.close();
    await server.close();
  }
});
