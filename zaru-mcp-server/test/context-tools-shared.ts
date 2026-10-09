// A conversation's chosen context through an entrypoint (AEGIS ADR-132 S7,
// S8; Zaru ADR-0055 D19b), shared by context-tools.test.ts (the container's
// Express app) and context-tools.worker.test.ts (the Workers entrypoint),
// with the orchestrator replaced by a loopback stub: API-key validation, SEAL
// tool discovery, attest, invoke and the context-tools listing. The stub
// lists `nuclear-notes.search` when the listing's `_meta.contexts` names a
// binding id, or a list of them, for `nuclear-notes` (Zaru ADR-0055 D20f), or
// when its `_meta.profile` is PROFILE (AEGIS ADR-140 D12), and refuses a
// listing naming FAILING_BINDING. It answers `GET /v1/profiles/{id}` as the
// orchestrator does to the profile's owner: PROFILE whole, NO_SUCH_PROFILE
// 404 and FORBIDDEN_PROFILE 403.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const API_KEY = "aegis_context_tools_test_key";
export const NODE_TOOL = "aegis.stub.echo";
export const CONTEXT_TOOL = "nuclear-notes.search";
export const BINDING = "3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c";
export const SECOND_BINDING = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
export const FAILING_BINDING = "00000000-0000-4000-8000-00000000dead";
// A conversation id in mixed case: forwarded unchanged means byte for byte.
export const CONVERSATION = "9B2E6F1A-3c4d-4E5F-8a9b-0C1D2E3F4A5B";
export const OTHER_CONVERSATION = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
export const PROFILE = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
export const SECOND_PROFILE = "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b";
export const NO_SUCH_PROFILE = "00000000-0000-4000-8000-0000000000aa";
export const FORBIDDEN_PROFILE = "00000000-0000-4000-8000-0000000000bb";
export const PROFILE_NOTES_WORKSPACE = "fundraising-notes";
export const PROFILE_INSTRUCTIONS = "Answer investors in two short paragraphs and never attach a file.";

export interface ContextStub {
  url: string;
  /** The payload of every POST /v1/seal/invoke, in order. */
  invoked: Array<Record<string, unknown>>;
  /** The payload of every POST /v1/seal/context-tools, in order. */
  listings: Array<Record<string, unknown>>;
  /** Every GET /v1/profiles/{id}: the id and the Authorization header, in order. */
  profileReads: Array<{ id: string; authorization: string | undefined }>;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

export async function startContextStub(): Promise<ContextStub> {
  const invoked: Array<Record<string, unknown>> = [];
  const listings: Array<Record<string, unknown>> = [];
  const profileReads: Array<{ id: string; authorization: string | undefined }> = [];
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/v1/api-keys/validate" && req.method === "POST") {
      if (req.headers.authorization !== `Bearer ${API_KEY}`) {
        sendJson(401, { error: "invalid api key" });
        return;
      }
      sendJson(200, {
        user_id: "context-tools-test-user",
        tenant_id: null,
        aegis_role: null,
        zaru_tier: "pro",
        scopes: [],
      });
      return;
    }
    if (url.pathname === "/v1/seal/tools" && req.method === "GET") {
      sendJson(200, {
        tools: [
          {
            name: NODE_TOOL,
            description: "Echo, from the stub orchestrator",
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
        payload: Record<string, unknown> & { id: unknown };
      };
      invoked.push(envelope.payload);
      sendJson(200, {
        jsonrpc: "2.0",
        id: envelope.payload.id,
        result: { content: [{ type: "text", text: "invoked" }] },
      });
      return;
    }
    const profileRoute = /^\/v1\/profiles\/([^/]+)$/.exec(url.pathname);
    if (profileRoute && req.method === "GET") {
      const id = decodeURIComponent(profileRoute[1]!);
      profileReads.push({ id, authorization: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${API_KEY}` || id === FORBIDDEN_PROFILE) {
        sendJson(403, { error: "insufficient_scope" });
        return;
      }
      if (id !== PROFILE) {
        sendJson(404, { error: "Not found" });
        return;
      }
      sendJson(200, {
        profile: {
          id: PROFILE,
          name: "Fundraising",
          bindings: [{ binding_id: BINDING, state: "active", label: "Notes" }],
          tools: ["nuclear-notes.*"],
          repository: null,
          notes_workspace: PROFILE_NOTES_WORKSPACE,
          instructions: PROFILE_INSTRUCTIONS,
          created_at: "2026-10-09T08:00:00Z",
          updated_at: "2026-10-09T08:00:00Z",
        },
      });
      return;
    }
    if (url.pathname === "/v1/seal/context-tools" && req.method === "POST") {
      const envelope = JSON.parse(await readBody(req)) as {
        payload: Record<string, unknown>;
      };
      listings.push(envelope.payload);
      const params = envelope.payload.params as
        | { _meta?: { contexts?: Record<string, unknown>; profile?: unknown } }
        | undefined;
      const choice = params?._meta?.contexts?.["nuclear-notes"];
      const named =
        params?._meta?.profile === PROFILE
          ? [BINDING]
          : typeof choice === "string" ? [choice] : Array.isArray(choice) ? choice : [];
      if (named.includes(FAILING_BINDING)) {
        sendJson(403, {
          protocol: "seal/v1",
          request_id: "6b1f1d2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
          status: "policy_violation",
          error: {
            code: "EXECUTION_BOUND_SESSION",
            message: "This listing is for a conversation, not an agent's run.",
            context: null,
            tool: null,
          },
        });
        return;
      }
      sendJson(200, {
        protocol: "seal/v1",
        tools:
          named.length > 0
            ? [
                {
                  name: CONTEXT_TOOL,
                  description: "Search the person's notes (stub)",
                  inputSchema: { type: "object", properties: {} },
                },
              ]
            : [],
      });
      return;
    }
    sendJson(404, { error: "stub: no such route" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    invoked,
    listings,
    profileReads,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** POSTs one JSON-RPC message to /mcp/v1 of the entrypoint under test. */
export type McpPost = (
  body: unknown,
  headers?: Record<string, string>,
) => Promise<Response>;

let nextId = 500;

function headersFor(contexts?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${API_KEY}`,
    ...(contexts === undefined ? {} : { "x-zaru-contexts": contexts }),
  };
}

async function rpc(
  post: McpPost,
  method: string,
  params: unknown,
  contexts?: string,
): Promise<{ result?: unknown; error?: { message: string } }> {
  const res = await post(
    { jsonrpc: "2.0", id: nextId++, method, params },
    headersFor(contexts),
  );
  assert.equal(res.status, 200, `HTTP ${res.status}: ${await res.clone().text()}`);
  return (await res.json()) as { result?: unknown; error?: { message: string } };
}

async function listedNames(post: McpPost, contexts?: string): Promise<string[]> {
  const answer = await rpc(post, "tools/list", {}, contexts);
  assert.ok(answer.result, `tools/list was not answered with tools: ${JSON.stringify(answer)}`);
  return (answer.result as { tools: Array<{ name: string }> }).tools.map(
    (t) => t.name,
  );
}

const chosen = JSON.stringify({ "nuclear-notes": BINDING });

/** The header naming one profile (AEGIS ADR-140 D12). */
const profileChosen = JSON.stringify({ "@profile": PROFILE });

/** The refusal of a header of any other shape (D12). */
const CONTEXTS_SHAPE =
  "x-zaru-contexts must be a JSON object naming one profile as @profile, or, for each server, a binding id, a list of binding ids, or null";

/** The refusal of two profiles, or a profile beside connections (D10). */
const ONE_PROFILE = "Choose one profile, or choose connections without a profile; not both.";

const PROFILE_HEADING = "# THE PERSON'S CHOSEN PROFILE";

/**
 * Registers the tests of the chosen context's tools against one entrypoint.
 * `context` is read when each test runs, after the file's `before` has
 * started the stub and the entrypoint.
 */
export function registerContextToolsTests(
  label: string,
  context: () => { post: McpPost; stub: ContextStub },
): void {
  test(`${label}: a chosen binding lists the context's tools beside the node's, by a signed tools/list carrying the choice`, async () => {
    const { post, stub } = context();
    const before = stub.listings.length;
    const names = await listedNames(post, chosen);
    const complaints: string[] = [];
    if (!names.includes(CONTEXT_TOOL)) complaints.push(`not listed: ${CONTEXT_TOOL} in ${names.join(", ")}`);
    if (!names.includes(NODE_TOOL)) complaints.push(`not listed: ${NODE_TOOL}`);
    const listing = stub.listings[before];
    if (!listing) {
      complaints.push("no POST /v1/seal/context-tools");
    } else {
      if (listing.method !== "tools/list") complaints.push(`the listing's method was ${String(listing.method)}`);
      const meta = (listing.params as { _meta?: unknown } | undefined)?._meta;
      if (JSON.stringify(meta) !== JSON.stringify({ contexts: { "nuclear-notes": BINDING } })) {
        complaints.push(`the listing's _meta was ${JSON.stringify(meta)}`);
      }
    }
    assert.deepEqual(complaints, []);
  });

  test(`${label}: no header, or a choice of none, lists no context tool and asks for none`, async () => {
    const { post, stub } = context();
    const before = stub.listings.length;
    const complaints: string[] = [];
    for (const [name, header] of [
      ["no header", undefined],
      ["none", JSON.stringify({ "nuclear-notes": null })],
    ] as const) {
      const names = await listedNames(post, header);
      if (names.includes(CONTEXT_TOOL)) complaints.push(`${name}: listed ${CONTEXT_TOOL}`);
      if (!names.includes(NODE_TOOL)) complaints.push(`${name}: not listed ${NODE_TOOL}`);
    }
    if (stub.listings.length !== before) complaints.push("a context-tools listing was asked for");
    assert.deepEqual(complaints, []);
  });

  test(`${label}: a refused context listing leaves the node's tools listed`, async () => {
    const { post } = context();
    const names = await listedNames(post, JSON.stringify({ "nuclear-notes": FAILING_BINDING }));
    assert.deepEqual(names.filter((n) => n === NODE_TOOL || n === CONTEXT_TOOL), [NODE_TOOL]);
  });

  test(`${label}: a call carries the choice in the signed payload's _meta, and its arguments unchanged`, async () => {
    const { post, stub } = context();
    const before = stub.invoked.length;
    await rpc(post, "tools/call", { name: CONTEXT_TOOL, arguments: { query: "q" } }, chosen);
    await rpc(post, "tools/call", { name: NODE_TOOL, arguments: { query: "q" } });
    const [withChoice, withNone] = stub.invoked.slice(before) as Array<{
      params: { name: string; arguments: unknown; _meta?: unknown };
    }>;
    const complaints: string[] = [];
    if (JSON.stringify(withChoice?.params._meta) !== JSON.stringify({ contexts: { "nuclear-notes": BINDING } })) {
      complaints.push(`the chosen call's _meta was ${JSON.stringify(withChoice?.params._meta)}`);
    }
    if (JSON.stringify(withChoice?.params.arguments) !== JSON.stringify({ query: "q" })) {
      complaints.push(`the chosen call's arguments were ${JSON.stringify(withChoice?.params.arguments)}`);
    }
    if (withNone && "_meta" in withNone.params) {
      complaints.push(`a call with no header carried _meta ${JSON.stringify(withNone.params._meta)}`);
    }
    assert.deepEqual(complaints, []);
  });

  test(`${label}: a malformed x-zaru-contexts is refused 400 with its sentence`, async () => {
    const { post, stub } = context();
    const before = stub.invoked.length;
    const complaints: string[] = [];
    for (const header of [
      "not json",
      JSON.stringify({ "nuclear-notes": "not-a-uuid" }),
      "[]",
      // A list must be non-empty, of binding ids, each named once whatever its
      // case (Zaru ADR-0055 D20f; ADR-0058 D3a).
      JSON.stringify({ "nuclear-notes": [] }),
      JSON.stringify({ "nuclear-notes": [BINDING, BINDING.toUpperCase()] }),
      JSON.stringify({ "nuclear-notes": [BINDING, "not-a-uuid"] }),
      JSON.stringify({ "nuclear-notes": [BINDING, null] }),
      // One profile is one profile id, a string (AEGIS ADR-140 D12).
      JSON.stringify({ "@profile": "not-a-uuid" }),
      JSON.stringify({ "@profile": null }),
      JSON.stringify({ "@profile": 7 }),
    ]) {
      const res = await post(
        { jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} },
        headersFor(header),
      );
      const body = await res.text();
      if (res.status !== 400) complaints.push(`${header}: HTTP ${res.status}`);
      if (!body.includes(CONTEXTS_SHAPE)) {
        complaints.push(`${header}: answered ${body}`);
      }
    }
    if (stub.invoked.length !== before) complaints.push("a call was forwarded");
    assert.deepEqual(complaints, []);
  });

  test(`${label}: a list of bindings is accepted and forwarded unchanged, on the listing and on a call`, async () => {
    const { post, stub } = context();
    const contexts = { "nuclear-notes": [BINDING, SECOND_BINDING], github: null };
    const header = JSON.stringify(contexts);
    const listingsBefore = stub.listings.length;
    const invokedBefore = stub.invoked.length;
    const names = await listedNames(post, header);
    await rpc(post, "tools/call", { name: CONTEXT_TOOL, arguments: { query: "q" } }, header);
    const complaints: string[] = [];
    if (!names.includes(CONTEXT_TOOL)) complaints.push(`not listed: ${CONTEXT_TOOL} in ${names.join(", ")}`);
    const listing = stub.listings[listingsBefore];
    const listingMeta = (listing?.params as { _meta?: unknown } | undefined)?._meta;
    if (JSON.stringify(listingMeta) !== JSON.stringify({ contexts })) {
      complaints.push(`the listing's _meta was ${JSON.stringify(listingMeta)}`);
    }
    const call = stub.invoked[invokedBefore] as { params: { _meta?: unknown } } | undefined;
    if (JSON.stringify(call?.params._meta) !== JSON.stringify({ contexts })) {
      complaints.push(`the call's _meta was ${JSON.stringify(call?.params._meta)}`);
    }
    assert.deepEqual(complaints, []);
  });

  test(`${label}: zaru.init teaches GitHub's sentence for a github binding, the mailbox sentence for an imap binding, and the generic one for a server with none of its own`, async () => {
    const { post } = context();
    const prompt = async (contexts: string) => {
      const answer = await rpc(post, "tools/call", { name: "zaru.init", arguments: { mode: "chat" } }, contexts);
      const text = (answer.result as { content: Array<{ text: string }> }).content[0]!.text;
      return (JSON.parse(text) as { system_prompt: string }).system_prompt;
    };
    const github = "The tools whose names begin with github. reach the person's GitHub repositories, issues and pull requests as their token allows.";
    const mailbox = "The tools whose names begin with mail. reach the person's mailbox they chose above the chat input";
    const imapGeneric = "The tools whose names begin with imap.";
    const generic = "The tools whose names begin with zeta. reach the person's zeta connection as their credential allows.";
    const nuclearNotes = "for Nuclear Notes, the tools whose names begin with nuclear-notes.";
    const complaints: string[] = [];
    const withGithub = await prompt(JSON.stringify({ github: [BINDING], "nuclear-notes": null }));
    if (!withGithub.includes(github)) complaints.push("github: GitHub's sentence not taught");
    if (withGithub.includes(nuclearNotes)) complaints.push("github: Nuclear Notes' paragraph taught");
    const withImap = await prompt(JSON.stringify({ imap: [BINDING] }));
    if (!withImap.includes(mailbox)) complaints.push("imap: the mailbox sentence not taught");
    if (withImap.includes(imapGeneric)) complaints.push("imap: the generic sentence taught");
    if (withImap.includes(nuclearNotes)) complaints.push("imap: Nuclear Notes' paragraph taught");
    const withZeta = await prompt(JSON.stringify({ zeta: [BINDING] }));
    if (!withZeta.includes(generic)) complaints.push("zeta: the generic sentence not taught");
    if (withZeta.includes(nuclearNotes)) complaints.push("zeta: Nuclear Notes' paragraph taught");
    assert.deepEqual(complaints, []);
  });

  // The conversation a call was made in (AEGIS ADR-126 Update of 2026-10-07
  // (2), clause 2): `x-zaru-conversation` reaches the orchestrator in the
  // signed payload's `_meta.conversation_id`, never in the arguments.
  const conversationHeaders = (conversation?: string, contexts?: string) => ({
    ...headersFor(contexts),
    ...(conversation === undefined ? {} : { "x-zaru-conversation": conversation }),
  });
  const callWith = async (
    post: McpPost,
    name: string,
    args: Record<string, unknown>,
    conversation?: string,
    contexts?: string,
  ) => {
    const res = await post(
      { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } },
      conversationHeaders(conversation, contexts),
    );
    assert.equal(res.status, 200, `HTTP ${res.status}: ${await res.clone().text()}`);
    return res.json();
  };

  test(`${label}: x-zaru-conversation is forwarded unchanged in the signed payload's _meta.conversation_id on a call, beside the contexts, never in the arguments; no header sends no key`, async () => {
    const { post, stub } = context();
    const before = stub.invoked.length;
    await callWith(post, NODE_TOOL, { query: "q" }, CONVERSATION);
    await callWith(post, CONTEXT_TOOL, { query: "q" }, CONVERSATION, chosen);
    await callWith(post, NODE_TOOL, { query: "q" });
    await callWith(post, CONTEXT_TOOL, { query: "q" }, undefined, chosen);
    const [alone, withContexts, none, contextsOnly] = stub.invoked.slice(before) as Array<{
      params: { name: string; arguments: unknown; _meta?: unknown };
    }>;
    const complaints: string[] = [];
    if (JSON.stringify(alone?.params._meta) !== JSON.stringify({ conversation_id: CONVERSATION })) {
      complaints.push(`the call's _meta was ${JSON.stringify(alone?.params._meta)}, not the conversation unchanged`);
    }
    if (
      JSON.stringify(withContexts?.params._meta) !==
      JSON.stringify({ contexts: { "nuclear-notes": BINDING }, conversation_id: CONVERSATION })
    ) {
      complaints.push(`the call with contexts carried _meta ${JSON.stringify(withContexts?.params._meta)}`);
    }
    for (const [which, call] of [["alone", alone], ["with contexts", withContexts]] as const) {
      if (JSON.stringify(call?.params.arguments) !== JSON.stringify({ query: "q" })) {
        complaints.push(`${which}: the arguments were ${JSON.stringify(call?.params.arguments)}`);
      }
    }
    if (none && "_meta" in none.params) {
      complaints.push(`a call with no header carried _meta ${JSON.stringify(none.params._meta)}`);
    }
    if (JSON.stringify(contextsOnly?.params._meta) !== JSON.stringify({ contexts: { "nuclear-notes": BINDING } })) {
      complaints.push(`a call with contexts and no conversation carried _meta ${JSON.stringify(contextsOnly?.params._meta)}`);
    }
    assert.deepEqual(complaints, []);
  });

  test(`${label}: a malformed x-zaru-conversation is refused 400 with its sentence, and nothing is forwarded`, async () => {
    const { post, stub } = context();
    const before = stub.invoked.length;
    const complaints: string[] = [];
    for (const header of [
      "not-a-uuid",
      `${CONVERSATION}, ${OTHER_CONVERSATION}`,
      "",
      `${CONVERSATION}x`,
      JSON.stringify([CONVERSATION]),
    ]) {
      const res = await post(
        { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: NODE_TOOL, arguments: {} } },
        conversationHeaders(header),
      );
      const body = await res.text();
      if (res.status !== 400) complaints.push(`${JSON.stringify(header)}: HTTP ${res.status}`);
      if (!body.includes("x-zaru-conversation must be one conversation id (a UUID)")) {
        complaints.push(`${JSON.stringify(header)}: answered ${body}`);
      }
    }
    if (stub.invoked.length !== before) complaints.push("a call was forwarded");
    assert.deepEqual(complaints, []);
  });

  test(`${label}: a script tool's call to the orchestrator carries the conversation too`, async () => {
    const { post, stub } = context();
    const before = stub.invoked.length;
    await callWith(post, "zaru.script.save", { name: "hello", code: "1" }, CONVERSATION);
    const call = stub.invoked[before] as { params: { name: string; arguments: unknown; _meta?: unknown } } | undefined;
    const complaints: string[] = [];
    if (call?.params.name !== "aegis.script.save") complaints.push(`the call forwarded was ${JSON.stringify(call?.params.name)}`);
    if (JSON.stringify(call?.params._meta) !== JSON.stringify({ conversation_id: CONVERSATION })) {
      complaints.push(`aegis.script.save carried _meta ${JSON.stringify(call?.params._meta)}`);
    }
    if (JSON.stringify(call?.params.arguments) !== JSON.stringify({ name: "hello", code: "1" })) {
      complaints.push(`the arguments were ${JSON.stringify(call?.params.arguments)}`);
    }
    assert.deepEqual(complaints, []);
  });

  test(`${label}: zaru.init teaches the chosen context only when one is chosen`, async () => {
    const { post } = context();
    const heading = "# THE PERSON'S CHOSEN CONTEXT";
    const prompt = async (contexts?: string) => {
      const answer = await rpc(post, "tools/call", { name: "zaru.init", arguments: { mode: "chat" } }, contexts);
      const text = (answer.result as { content: Array<{ text: string }> }).content[0]!.text;
      return (JSON.parse(text) as { system_prompt: string }).system_prompt;
    };
    const complaints: string[] = [];
    if (!(await prompt(chosen)).includes(heading)) complaints.push("chosen: no teaching");
    if ((await prompt()).includes(heading)) complaints.push("no header: taught");
    if ((await prompt(JSON.stringify({ "nuclear-notes": null }))).includes(heading)) complaints.push("none: taught");
    assert.deepEqual(complaints, []);
  });

  // One profile per conversation (AEGIS ADR-140 D10, D12): `{"@profile": id}`
  // alone, forwarded in the signed payload's `_meta.profile` on every call and
  // on the listing, never in the arguments and never in `_meta.contexts`.
  test(`${label}: {"@profile": id} is accepted; the listing and every call carry it in _meta.profile alone, the arguments unchanged`, async () => {
    const { post, stub } = context();
    const listingsBefore = stub.listings.length;
    const invokedBefore = stub.invoked.length;
    const names = await listedNames(post, profileChosen);
    await callWith(post, CONTEXT_TOOL, { query: "q" }, undefined, profileChosen);
    await callWith(post, NODE_TOOL, { query: "q" }, CONVERSATION, profileChosen);
    await callWith(post, "zaru.script.save", { name: "hello", code: "1" }, CONVERSATION, profileChosen);
    const complaints: string[] = [];
    if (!names.includes(CONTEXT_TOOL)) complaints.push(`not listed: ${CONTEXT_TOOL} in ${names.join(", ")}`);
    if (!names.includes(NODE_TOOL)) complaints.push(`not listed: ${NODE_TOOL}`);
    const listing = stub.listings[listingsBefore];
    const listingMeta = (listing?.params as { _meta?: unknown } | undefined)?._meta;
    if (JSON.stringify(listingMeta) !== JSON.stringify({ profile: PROFILE })) {
      complaints.push(`the listing's _meta was ${JSON.stringify(listingMeta)}`);
    }
    const [alone, withConversation, script] = stub.invoked.slice(invokedBefore) as Array<{
      params: { name: string; arguments: unknown; _meta?: unknown };
    }>;
    if (JSON.stringify(alone?.params._meta) !== JSON.stringify({ profile: PROFILE })) {
      complaints.push(`the call's _meta was ${JSON.stringify(alone?.params._meta)}`);
    }
    if (JSON.stringify(withConversation?.params._meta) !== JSON.stringify({ conversation_id: CONVERSATION, profile: PROFILE })) {
      complaints.push(`the call in a conversation carried _meta ${JSON.stringify(withConversation?.params._meta)}`);
    }
    if (script?.params.name !== "aegis.script.save" || JSON.stringify(script?.params._meta) !== JSON.stringify({ conversation_id: CONVERSATION, profile: PROFILE })) {
      complaints.push(`the script tool's call carried ${JSON.stringify(script?.params.name)} with _meta ${JSON.stringify(script?.params._meta)}`);
    }
    for (const [which, call] of [["alone", alone], ["in a conversation", withConversation]] as const) {
      if (JSON.stringify(call?.params.arguments) !== JSON.stringify({ query: "q" })) {
        complaints.push(`${which}: the arguments were ${JSON.stringify(call?.params.arguments)}`);
      }
    }
    assert.deepEqual(complaints, []);
  });

  test(`${label}: a list under @profile, @profile beside a server, and any other @ key are refused 400 with the one-profile sentence, and nothing is forwarded`, async () => {
    const { post, stub } = context();
    const invokedBefore = stub.invoked.length;
    const listingsBefore = stub.listings.length;
    const complaints: string[] = [];
    for (const header of [
      JSON.stringify({ "@profile": [PROFILE] }),
      JSON.stringify({ "@profile": [PROFILE, SECOND_PROFILE] }),
      JSON.stringify({ "@profile": PROFILE, "nuclear-notes": BINDING }),
      JSON.stringify({ "nuclear-notes": [BINDING], "@profile": PROFILE }),
      JSON.stringify({ "@profile": PROFILE, github: null }),
      JSON.stringify({ "@profile": PROFILE, "@workspace": "x" }),
      JSON.stringify({ "@profiles": PROFILE }),
      JSON.stringify({ "@": BINDING }),
    ]) {
      for (const method of ["tools/list", "tools/call"] as const) {
        const params = method === "tools/list" ? {} : { name: NODE_TOOL, arguments: {} };
        const res = await post({ jsonrpc: "2.0", id: nextId++, method, params }, headersFor(header));
        const body = await res.text();
        if (res.status !== 400) complaints.push(`${header} ${method}: HTTP ${res.status}`);
        if (!body.includes(ONE_PROFILE)) complaints.push(`${header} ${method}: answered ${body}`);
      }
    }
    if (stub.invoked.length !== invokedBefore) complaints.push("a call was forwarded");
    if (stub.listings.length !== listingsBefore) complaints.push("a listing was asked for");
    assert.deepEqual(complaints, []);
  });

  test(`${label}: zaru.init and zaru.mode read the chosen profile once with the caller's token and teach its workspace and instructions under one heading; without a profile nothing is read or taught`, async () => {
    const { post, stub } = context();
    const promptOf = async (tool: string, contexts?: string) => {
      const answer = await rpc(post, "tools/call", { name: tool, arguments: { mode: "chat" } }, contexts);
      const text = (answer.result as { content: Array<{ text: string }> }).content[0]!.text;
      return (JSON.parse(text) as { system_prompt: string }).system_prompt;
    };
    const complaints: string[] = [];
    for (const tool of ["zaru.init", "zaru.mode"]) {
      const readsBefore = stub.profileReads.length;
      const prompt = await promptOf(tool, profileChosen);
      const reads = stub.profileReads.slice(readsBefore);
      if (reads.length !== 1 || reads[0]!.id !== PROFILE || reads[0]!.authorization !== `Bearer ${API_KEY}`) {
        complaints.push(`${tool}: the profile was read as ${JSON.stringify(reads)}`);
      }
      const at = prompt.indexOf(PROFILE_HEADING);
      if (at < 0 || prompt.indexOf(PROFILE_HEADING, at + 1) >= 0) complaints.push(`${tool}: the heading was not taught once`);
      const section = prompt.slice(at);
      if (!section.includes(PROFILE_INSTRUCTIONS)) complaints.push(`${tool}: the instructions were not taught under the heading`);
      if (!section.includes(PROFILE_NOTES_WORKSPACE)) complaints.push(`${tool}: the notes workspace was not taught under the heading`);
      if (prompt.includes("# THE PERSON'S CHOSEN CONTEXT")) complaints.push(`${tool}: the contexts' heading was taught for a profile`);
      const plainBefore = stub.profileReads.length;
      for (const header of [undefined, chosen]) {
        if ((await promptOf(tool, header)).includes(PROFILE_HEADING)) complaints.push(`${tool} ${header}: the profile heading was taught`);
      }
      if (stub.profileReads.length !== plainBefore) complaints.push(`${tool}: a profile was read with none chosen`);
    }
    assert.deepEqual(complaints, []);
  });

  test(`${label}: a profile the route refuses (404, 403) teaches no profile heading, and a call still carries _meta.profile`, async () => {
    const { post, stub } = context();
    const complaints: string[] = [];
    for (const profile of [NO_SUCH_PROFILE, FORBIDDEN_PROFILE]) {
      const header = JSON.stringify({ "@profile": profile });
      const answer = await rpc(post, "tools/call", { name: "zaru.init", arguments: { mode: "chat" } }, header);
      const text = (answer.result as { content: Array<{ text: string }> }).content[0]!.text;
      const prompt = (JSON.parse(text) as { system_prompt?: string }).system_prompt;
      if (typeof prompt !== "string") complaints.push(`${profile}: zaru.init answered ${text.slice(0, 200)}`);
      else if (prompt.includes(PROFILE_HEADING)) complaints.push(`${profile}: the profile heading was taught`);
      const before = stub.invoked.length;
      await callWith(post, NODE_TOOL, { query: "q" }, undefined, header);
      const call = stub.invoked[before] as { params: { _meta?: unknown } } | undefined;
      if (JSON.stringify(call?.params._meta) !== JSON.stringify({ profile })) {
        complaints.push(`${profile}: the call carried _meta ${JSON.stringify(call?.params._meta)}`);
      }
    }
    assert.deepEqual(complaints, []);
  });
}
