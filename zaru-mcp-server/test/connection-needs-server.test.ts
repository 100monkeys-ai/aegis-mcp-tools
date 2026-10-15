// Zaru ADR-0070 (connection cards), the Zaru MCP server's half, Trigger 2
// (a) to (d), arc `connection-needs-server`:
//
// (a) D5: a relayed refusal keeps the orchestrator's `error.needs` in D1's
//     shape ({family, page}) and drops one of any other shape;
// (b) D3 (a): `zaru.connection.needed`, served by the server itself, answers
//     not connected, connected but not chosen, and not in the chosen profile
//     from the person's own listing (ADR-0069 D2), the turn's
//     `x-zaru-contexts` choice and its `@profile`;
// (c) D3 (b): every mode's prompt carries the three sentences, and D3 (c):
//     the chosen context's own refusal line stands beside them;
// (d) ADR-0056 / AEGIS ADR-134: the new facing text is served where the
//     facing-text test reads, and none of it names a decision record.
//
// The orchestrator's `needs` (D1) is built by `connection-needs-orchestrator`;
// the bodies below are fakes in D1's shape.
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  failureToolResult,
  relayFailure,
  type OrchestratorClient,
} from "../src/mcp/orchestrator-client.js";
import {
  createMcpServerForUser,
  type ContextChoices,
  type McpRequestContext,
} from "../src/mcp/streamable-http.js";
import { getZaruInit } from "../src/prompts/index.js";
import type { ZaruUser } from "../src/middleware/auth.js";

const REQUEST_ID = "217877e3-8179-4c5a-b7a9-e6c0ee8c511b";
const PROFILE_ID = "5f0c2d1e-8a3b-4c7d-9e6f-0a1b2c3d4e5f";
const BINDING_ID = "0b6f3a2c-1d4e-4f5a-8b9c-7d6e5f4a3b2c";

const NOT_CONNECTED_SENTENCE =
  "You have not connected a calendar to Zaru. Connect it on the Connections page in Zaru Web (ask.myzaru.com/vault/connections), then try again.";

/** A refusal body as the orchestrator answers it with D1's `needs` (fake). */
function refusal(code: string, message: string, needs?: unknown): unknown {
  return {
    protocol: "seal/v1",
    request_id: REQUEST_ID,
    status: "policy_violation",
    error: { code, message, context: null, tool: "calendar.list", ...(needs !== undefined ? { needs } : {}) },
  };
}

/** The relayed payload a client reads from the tool result's one text item. */
function relayed(body: unknown, status = 403): Record<string, any> {
  const result = failureToolResult(relayFailure("invoke", status, body));
  assert.equal(result.content.length, 1);
  return JSON.parse(result.content[0]!.text);
}

// ---------------------------------------------------------------------------
// (a) The relay keeps `needs` in D1's shape and drops a malformed one.
// ---------------------------------------------------------------------------

test("Trigger 2 (a): a relayed CREDENTIAL_BINDING_REQUIRED refusal keeps error.needs beside its code and sentence", () => {
  const payload = relayed(
    refusal("CREDENTIAL_BINDING_REQUIRED", NOT_CONNECTED_SENTENCE, { family: "calendar", page: "/vault/connections" }),
  );
  assert.deepEqual(payload, {
    error: {
      code: "CREDENTIAL_BINDING_REQUIRED",
      message: NOT_CONNECTED_SENTENCE,
      needs: { family: "calendar", page: "/vault/connections" },
    },
    request_id: REQUEST_ID,
  });
});

test("Trigger 2 (a): every family and page D1 names is relayed as given", () => {
  const shapes = [
    { family: "mailbox", page: "/vault/connections" },
    { family: "calendar", page: "/vault/connections" },
    { family: "github", page: "/vault/connections" },
    { family: "nuclear-notes", page: "/vault/connections" },
    { family: "linear", page: "/vault/connections" },
    { family: "profile", page: "/vault/profiles" },
    { family: "profile", page: `/vault/profiles/${PROFILE_ID}` },
  ];
  for (const needs of shapes) {
    const payload = relayed(refusal("CREDENTIAL_BINDING_REQUIRED", NOT_CONNECTED_SENTENCE, needs));
    assert.deepEqual(payload.error.needs, needs, JSON.stringify(needs));
  }
});

test("Trigger 2 (a): a TOOL_NOT_IN_PROFILE refusal (403 policy_violation) is relayed with its sentence and its needs, not as invoke_failed", () => {
  const sentence = "This tool is not in the profile chosen for this conversation.";
  const needs = { family: "profile", page: `/vault/profiles/${PROFILE_ID}` };
  const payload = relayed(refusal("TOOL_NOT_IN_PROFILE", sentence, needs));
  assert.deepEqual(payload.error, { code: "TOOL_NOT_IN_PROFILE", message: sentence, needs });
});

test("Trigger 2 (a): a needs of any other shape is dropped and the refusal is relayed without it", () => {
  const malformed: unknown[] = [
    null,
    "mailbox",
    ["mailbox", "/vault/connections"],
    {},
    { family: "mailbox" },
    { page: "/vault/connections" },
    { family: "mailbox", page: "/vault/connections", extra: true },
    { family: "", page: "/vault/connections" },
    { family: 7, page: "/vault/connections" },
    { family: "Mail Box", page: "/vault/connections" },
    { family: "mailbox", page: "https://evil.example/vault/connections" },
    { family: "mailbox", page: "//evil.example" },
    { family: "mailbox", page: "/vault/connections/google" },
    { family: "mailbox", page: "/vault/profiles" },
    { family: "profile", page: "/vault/connections" },
    { family: "profile", page: "/vault/profiles/not-a-profile-id" },
    { family: "profile", page: `/vault/profiles/${PROFILE_ID}/edit` },
  ];
  for (const needs of malformed) {
    const payload = relayed(refusal("CREDENTIAL_BINDING_REQUIRED", NOT_CONNECTED_SENTENCE, needs));
    assert.deepEqual(
      payload,
      { error: { code: "CREDENTIAL_BINDING_REQUIRED", message: NOT_CONNECTED_SENTENCE }, request_id: REQUEST_ID },
      `needs ${JSON.stringify(needs)} should be dropped`,
    );
  }
});

test("Trigger 2 (a): a refusal without needs is relayed exactly as before, and an internal row never carries one", () => {
  assert.deepEqual(relayed(refusal("CREDENTIAL_BINDING_REQUIRED", NOT_CONNECTED_SENTENCE)), {
    error: { code: "CREDENTIAL_BINDING_REQUIRED", message: NOT_CONNECTED_SENTENCE },
    request_id: REQUEST_ID,
  });
  const internal = relayed(
    {
      protocol: "seal/v1",
      request_id: REQUEST_ID,
      status: "error",
      error: { code: "INTERNAL_ERROR", message: "boom", needs: { family: "mailbox", page: "/vault/connections" } },
    },
    500,
  );
  assert.equal(internal.error.needs, undefined);
});

// ---------------------------------------------------------------------------
// (b) zaru.connection.needed answers the three states.
// ---------------------------------------------------------------------------

type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };
const tool = (name: string): Tool => ({ name, description: name, inputSchema: { type: "object", properties: {} } });

interface Stub {
  /** The person's own listing (ADR-0069 D2). */
  listed: string[];
  /** The chosen profile's listing, when one is chosen. */
  profileListed?: string[];
  calls: string[];
}

function stubClient(stub: Stub): OrchestratorClient {
  return {
    listTools: async () => {
      stub.calls.push("listTools");
      return stub.listed.map(tool);
    },
    listContextTools: async (_user: ZaruUser, choice: { profile?: string; contexts?: unknown }) => {
      stub.calls.push(`listContextTools ${JSON.stringify(choice)}`);
      return "profile" in choice ? (stub.profileListed ?? []).map(tool) : [];
    },
    invokeTool: async () => {
      stub.calls.push("invokeTool");
      throw new Error("zaru.connection.needed must call nothing but the listings");
    },
  } as unknown as OrchestratorClient;
}

const USER: ZaruUser = {
  userId: "user-1",
  tier: "pro",
  securityContext: "zaru-pro",
  token: "a.b.c",
  isOperator: false,
  tenantId: "tenant-1",
};

async function withServer<T>(
  stub: Stub,
  context: McpRequestContext,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createMcpServerForUser(USER, new Set(), "connection-needs", stubClient(stub), context);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "connection-needs", version: "0" });
  await client.connect(clientSide);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function needed(
  stub: Stub,
  context: McpRequestContext,
  family: unknown,
): Promise<{ isError: boolean; answer: Record<string, any> }> {
  return withServer(stub, context, async (client) => {
    const result = (await client.callTool({ name: "zaru.connection.needed", arguments: { family } })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    return { isError: result.isError === true, answer: JSON.parse(result.content[0]!.text) };
  });
}

test("Trigger 2 (b): tools/list advertises zaru.connection.needed, taking {family}", async () => {
  const stub: Stub = { listed: ["web.search"], calls: [] };
  const tools = await withServer(stub, {}, async (client) => (await client.listTools()).tools);
  const entry = tools.find((t) => t.name === "zaru.connection.needed");
  assert.ok(entry, `zaru.connection.needed is not listed: ${tools.map((t) => t.name).join(", ")}`);
  assert.deepEqual((entry!.inputSchema as any).required, ["family"]);
  assert.equal((entry!.inputSchema as any).properties.family.type, "string");
});

test("Trigger 2 (b): not connected: no tool of the family in the person's listing", async () => {
  const stub: Stub = { listed: ["web.search", "github.list_issues"], calls: [] };
  const { isError, answer } = await needed(stub, {}, "mailbox");
  assert.equal(isError, false);
  assert.deepEqual(answer, {
    needs: { family: "mailbox", page: "/vault/connections" },
    sentence: "A mailbox is not connected to Zaru. Connect it on the Connections page in Zaru Web.",
  });
  assert.deepEqual(stub.calls, ["listTools"]);
});

test("Trigger 2 (b): connected but not chosen: the family is listed and the turn's x-zaru-contexts names no binding of it", async () => {
  const choices: Array<ContextChoices | undefined> = [undefined, {}, { imap: null }, { github: BINDING_ID }, { imap: [] }];
  for (const contexts of choices) {
    const stub: Stub = { listed: ["web.search", "mail.list", "mail.read"], calls: [] };
    const { isError, answer } = await needed(stub, contexts === undefined ? { zaruTurn: true } : { zaruTurn: true, contexts }, "mailbox");
    assert.equal(isError, false);
    assert.deepEqual(
      answer,
      {
        needs: { family: "mailbox", page: "/vault/connections" },
        sentence: "Your mailbox is connected but not chosen for this conversation. Choose it under Context above the chat input.",
      },
      JSON.stringify(contexts),
    );
    assert.deepEqual(stub.calls, ["listTools"]);
  }
});

test("Trigger 2 (b): not in the chosen profile: the family is listed and the @profile's listing holds none of its tools", async () => {
  const stub: Stub = { listed: ["web.search", "calendar.list"], profileListed: ["github.list_issues"], calls: [] };
  const { isError, answer } = await needed(stub, { profile: PROFILE_ID }, "calendar");
  assert.equal(isError, false);
  assert.deepEqual(answer, {
    needs: { family: "profile", page: `/vault/profiles/${PROFILE_ID}` },
    sentence: "The profile chosen for this conversation does not allow this. Change it on the profile's page in Zaru Web.",
  });
  assert.deepEqual(stub.calls, ["listTools", `listContextTools {"profile":"${PROFILE_ID}"}`]);
});

test("Trigger 2 (b): with a profile chosen, a family the person has not connected is still not connected", async () => {
  const stub: Stub = { listed: ["web.search"], profileListed: [], calls: [] };
  const { answer } = await needed(stub, { profile: PROFILE_ID }, "github");
  assert.deepEqual(answer, {
    needs: { family: "github", page: "/vault/connections" },
    sentence: "GitHub is not connected to Zaru. Connect it on the Connections page in Zaru Web.",
  });
});

test("Trigger 2 (b): each family names itself, and a remote server by its own name", async () => {
  const cases: Array<[string, string, string, Record<string, string>]> = [
    ["calendar", "A calendar", "Your calendar", { caldav: BINDING_ID }],
    ["github", "GitHub", "Your GitHub", { github: BINDING_ID }],
    ["nuclear-notes", "Nuclear Notes", "Your Nuclear Notes", { "nuclear-notes": BINDING_ID }],
    ["linear", "linear", "Your linear", { linear: BINDING_ID }],
  ];
  for (const [family, absent, present] of cases) {
    const missing = await needed({ listed: ["web.search"], calls: [] }, {}, family);
    assert.equal(missing.answer.sentence, `${absent} is not connected to Zaru. Connect it on the Connections page in Zaru Web.`);
    const toolName = family === "calendar" ? "calendar.list" : `${family}.read`;
    const unchosen = await needed({ listed: [toolName], calls: [] }, { zaruTurn: true }, family);
    assert.equal(
      unchosen.answer.sentence,
      `${present} is connected but not chosen for this conversation. Choose it under Context above the chat input.`,
    );
    assert.deepEqual(unchosen.answer.needs, { family, page: "/vault/connections" });
  }
});

test("Trigger 2 (b): connected and chosen, or allowed by the profile: nothing is needed", async () => {
  const chosen = await needed({ listed: ["mail.list"], calls: [] }, { zaruTurn: true, contexts: { imap: BINDING_ID } }, "mailbox");
  assert.deepEqual(chosen.answer, { needs: null, sentence: "Your mailbox is connected and chosen for this conversation." });
  const allowed = await needed(
    { listed: ["calendar.list"], profileListed: ["calendar.list"], calls: [] },
    { profile: PROFILE_ID },
    "calendar",
  );
  assert.deepEqual(allowed.answer, { needs: null, sentence: "Your calendar is connected and chosen for this conversation." });
});

test("Trigger 2 (b): off a Zaru Web turn (a remote MCP client, which chooses no context) a connected family needs nothing", async () => {
  const stub: Stub = { listed: ["web.search", "mail.list"], calls: [] };
  const { isError, answer } = await needed(stub, {}, "mailbox");
  assert.equal(isError, false);
  assert.deepEqual(answer, { needs: null, sentence: "Your mailbox is connected to Zaru." });
  assert.deepEqual(stub.calls, ["listTools"]);
});

test("Trigger 2 (b): a family that is not a family is refused and nothing is read", async () => {
  for (const family of [undefined, "", 7, "profile", "Mail Box", "../x"]) {
    const stub: Stub = { listed: ["mail.list"], calls: [] };
    const { isError, answer } = await needed(stub, {}, family);
    assert.equal(isError, true, JSON.stringify(family));
    assert.equal(typeof answer.error, "string");
    assert.deepEqual(stub.calls, []);
  }
});

// ---------------------------------------------------------------------------
// (c) Every mode's prompt carries D3's three sentences.
// ---------------------------------------------------------------------------

const D3_SENTENCES = [
  "When a message needs the person's mail, calendar, GitHub, Nuclear Notes or another connection and no tool of it is listed to you, call zaru.connection.needed with that family, tell the person in one sentence what to connect or choose and that the card above takes them there, and end your turn. Ask nothing else.",
  "When a call is refused because something is not connected, not chosen or not in the chosen profile, tell the person in one sentence what is missing and that the card above takes them there, and end your turn.",
  "Never say a connection is or is not made unless a tool's answer says so.",
];

const OPERATOR = { isOperator: true, tier: "operator" };
const MODES: Array<[string, () => ReturnType<typeof getZaruInit>]> = [
  ["chat", () => getZaruInit("chat")],
  ["agentic", () => getZaruInit("agentic")],
  ["agentic+chat-uploads", () => getZaruInit("agentic", new Set(["chat-uploads"]))],
  ["workflow", () => getZaruInit("workflow")],
  ["workflow+chat-uploads", () => getZaruInit("workflow", new Set(["chat-uploads"]))],
  ["execute", () => getZaruInit("execute")],
  ["live", () => getZaruInit("live", new Set(["live"]), "browser")],
  ["vibecode", () => getZaruInit("vibecode", new Set(["vibecode"]), "browser")],
  ["operator", () => getZaruInit("operator", new Set(), undefined, OPERATOR)],
];

test("Trigger 2 (c): every mode's prompt carries D3's three sentences verbatim, once each, in order", () => {
  for (const [name, init] of MODES) {
    const prompt = init()!.system_prompt;
    const positions = D3_SENTENCES.map((sentence) => {
      assert.equal(prompt.split(sentence).length, 2, `the ${name} prompt holds "${sentence.slice(0, 40)}…" once`);
      return prompt.indexOf(sentence);
    });
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, `the ${name} prompt holds them in order`);
  }
});

test("Trigger 2 (c): with a context or a profile chosen, the sentences stand before its teaching, and its own refusal line stands for every other refusal", () => {
  const refusalLine = "If a call is refused, tell the person in one sentence and answer without it.";
  for (const [name, mode, caps, runtime, user] of [
    ["chat", "chat", new Set<string>(), undefined, undefined],
    ["agentic", "agentic", new Set<string>(), undefined, undefined],
    ["operator", "operator", new Set<string>(), undefined, OPERATOR],
  ] as const) {
    const prompt = getZaruInit(mode, caps, runtime, user, { imap: BINDING_ID })!.system_prompt;
    const heading = prompt.indexOf("# THE PERSON'S CHOSEN CONTEXT");
    assert.ok(heading > 0, `${name}: the context heading is taught`);
    for (const sentence of D3_SENTENCES) assert.ok(prompt.includes(sentence), `${name}: D3's sentences are taught with a context chosen`);
    assert.ok(prompt.indexOf(D3_SENTENCES[2]!) < heading, `${name}: D3's sentences come before the context teaching`);
    assert.ok(prompt.indexOf(refusalLine, heading) > heading, `${name}: the context's refusal line stands`);
    const withProfile = getZaruInit(mode, caps, runtime, user, {}, { name: "Work" })!.system_prompt;
    assert.ok(withProfile.includes(D3_SENTENCES[2]!), `${name}: D3's sentences are taught with a profile chosen`);
    assert.ok(withProfile.indexOf(D3_SENTENCES[2]!) < withProfile.indexOf("# THE PERSON'S CHOSEN PROFILE"), `${name}: before the profile teaching`);
  }
});

test("Trigger 2 (b), C1: every mode's tool list holds zaru.connection.needed once, right after zaru.docs, so the server's lists and Zaru Web's agree", () => {
  for (const [name, init] of MODES) {
    const tools = init()!.available_tools;
    assert.equal(tools.filter((t) => t === "zaru.connection.needed").length, 1, `${name} lists it once`);
    assert.equal(tools[tools.indexOf("zaru.docs") + 1], "zaru.connection.needed", `${name} lists it right after zaru.docs`);
  }
});

// ---------------------------------------------------------------------------
// (d) The facing text holds them, and none of it names a decision record.
// ---------------------------------------------------------------------------

/** The facing-text test's pattern (test/facing-text-no-record-refs.test.ts). */
const RECORD_REFERENCE =
  /ADR-[0-9]|CD-[0-9]|ADR [0-9]|[Dd]ecision record|security audit 0|audit 0[0-9][0-9]|§[0-9]/;

test("Trigger 2 (d): the new tool, its answers and D3's sentences are served where the facing-text test reads, and none names a record", async () => {
  const facing: string[] = [];
  const stub: Stub = { listed: ["web.search", "mail.list"], profileListed: [], calls: [] };
  const tools = await withServer(stub, {}, async (client) => (await client.listTools()).tools);
  const entry = tools.find((t) => t.name === "zaru.connection.needed");
  assert.ok(entry, "zaru.connection.needed is served on tools/list");
  facing.push(entry!.name, entry!.description ?? "", JSON.stringify(entry!.inputSchema));
  assert.ok((entry!.description ?? "").length > 0, "the tool has a description");
  for (const [family, context] of [
    ["github", {}],
    ["mailbox", {}],
    ["mailbox", { profile: PROFILE_ID }],
    ["mailbox", { zaruTurn: true }],
    ["mailbox", { zaruTurn: true, contexts: { imap: BINDING_ID } }],
    ["profile", {}],
  ] as const) {
    const { answer } = await needed({ ...stub, calls: [] }, context, family);
    facing.push(JSON.stringify(answer));
  }
  for (const [name, init] of MODES) {
    const prompt = init()!.system_prompt;
    for (const sentence of D3_SENTENCES) assert.ok(prompt.includes(sentence), `${name} serves D3's sentences`);
    facing.push(prompt);
  }
  const hits = facing.flatMap((text) => text.split("\n")).filter((line) => RECORD_REFERENCE.test(line));
  assert.deepEqual(hits, []);
});
