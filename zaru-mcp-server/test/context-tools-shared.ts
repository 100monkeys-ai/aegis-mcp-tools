// A conversation's chosen context through an entrypoint (AEGIS ADR-132 S7,
// S8; Zaru ADR-0055 D19b), shared by context-tools.test.ts (the container's
// Express app) and context-tools.worker.test.ts (the Workers entrypoint),
// with the orchestrator replaced by a loopback stub: API-key validation, SEAL
// tool discovery, attest, invoke and the context-tools listing. The stub
// lists `nuclear-notes.search` when the listing's `_meta.contexts` names a
// binding id, or a list of them, for `nuclear-notes` (Zaru ADR-0055 D20f),
// and refuses a listing naming FAILING_BINDING.
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

export interface ContextStub {
  url: string;
  /** The payload of every POST /v1/seal/invoke, in order. */
  invoked: Array<Record<string, unknown>>;
  /** The payload of every POST /v1/seal/context-tools, in order. */
  listings: Array<Record<string, unknown>>;
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
    if (url.pathname === "/v1/seal/context-tools" && req.method === "POST") {
      const envelope = JSON.parse(await readBody(req)) as {
        payload: Record<string, unknown>;
      };
      listings.push(envelope.payload);
      const params = envelope.payload.params as
        | { _meta?: { contexts?: Record<string, unknown> } }
        | undefined;
      const choice = params?._meta?.contexts?.["nuclear-notes"];
      const named = typeof choice === "string" ? [choice] : Array.isArray(choice) ? choice : [];
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
    ]) {
      const res = await post(
        { jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} },
        headersFor(header),
      );
      const body = await res.text();
      if (res.status !== 400) complaints.push(`${header}: HTTP ${res.status}`);
      if (!body.includes("x-zaru-contexts must be a JSON object naming, for each server, a binding id, a list of binding ids, or null")) {
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
}
