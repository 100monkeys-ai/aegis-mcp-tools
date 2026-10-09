// zaru.conversations.list, .read and .search (Zaru ADR-0059 C1, C2, C6, C11):
// the client's three reads of Zaru Web, the handlers' refusals, and the tools
// through the container's entrypoint (the real Express app of src/app.ts
// behind the real auth middleware) with the orchestrator and Zaru Web replaced
// by a loopback stub. The Workers entrypoint parses `x-zaru-conversation` the
// same way and builds the same server (`src/worker.ts`), so it adds no path of
// its own here.
//
// Zaru Web's routes are stubbed from what `zaru-client` 0194c61f serves:
// `GET /api/zaru-conversations/` (`limit`, `current`),
// `/api/zaru-conversations/<id>` (`cursor`, `page_size`, `current`) and
// `/api/zaru-conversations/search` (`q`, `limit`, `current`), each answering
// C1's output object or `{ error, message }` with its status.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  CONVERSATION_REFUSAL_MESSAGES,
  ZaruClient,
  type ZaruConversationsAnswer,
} from "../src/clients/zaru-client.js";
import type { ZaruUser } from "../src/middleware/auth.js";

// streamable-http.ts builds its Zaru Web client from ZARU_CLIENT_URL when it
// is first imported, so it is imported only after this file's `before` has
// pointed that at the stub.
const handlers = () => import("../src/mcp/streamable-http.js");

const RECORD_REFERENCE =
  /ADR-[0-9]|CD-[0-9]|ADR [0-9]|[Dd]ecision record|security audit 0|audit 0[0-9][0-9]|§[0-9]/;

const USER: ZaruUser = {
  userId: "user-1",
  tier: "pro",
  securityContext: "zaru-pro",
  token: "aegis_key_abc",
  isOperator: false,
};

const CONVERSATION = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
const CURRENT = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

// ---------------------------------------------------------------------------
// The client: one GET per read, the caller's token as Bearer, only the
// parameters given, and the refusal mapping.
// ---------------------------------------------------------------------------

function clientAnswering(respond: () => Response | Promise<Response>): {
  client: ZaruClient;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new ZaruClient({
    baseUrl: "https://zaru.example/",
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return respond();
    },
  });
  return { client, calls };
}

function bearerOf(init?: RequestInit): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

test("client: list GETs /api/zaru-conversations/ with the caller's token as Bearer, and current only when given", async () => {
  const output = { conversations: [], more: false };
  const { client, calls } = clientAnswering(() => Response.json(output));
  assert.deepEqual(await client.listConversations(USER, {}), { ok: true, output });
  await client.listConversations(USER, { limit: 5, current: CURRENT });
  assert.equal(calls[0]!.url, "https://zaru.example/api/zaru-conversations/");
  assert.equal(
    calls[1]!.url,
    `https://zaru.example/api/zaru-conversations/?limit=5&current=${CURRENT}`,
  );
  for (const call of calls) {
    assert.equal(call.init?.method, "GET");
    assert.equal(bearerOf(call.init), "Bearer aegis_key_abc");
  }
});

test("client: read GETs /api/zaru-conversations/<id> with cursor, page_size and current only when given", async () => {
  const { client, calls } = clientAnswering(() =>
    Response.json({ conversation: {}, messages: [], next_cursor: null }),
  );
  await client.readConversation(USER, { conversationId: CONVERSATION });
  await client.readConversation(USER, {
    conversationId: CONVERSATION,
    cursor: "abc_-",
    pageSize: 10,
    current: CURRENT,
  });
  assert.equal(calls[0]!.url, `https://zaru.example/api/zaru-conversations/${CONVERSATION}`);
  assert.equal(
    calls[1]!.url,
    `https://zaru.example/api/zaru-conversations/${CONVERSATION}?cursor=abc_-&page_size=10&current=${CURRENT}`,
  );
  assert.ok(calls.every((call) => bearerOf(call.init) === "Bearer aegis_key_abc"));
});

test("client: search GETs /api/zaru-conversations/search with q, limit and current only when given", async () => {
  const { client, calls } = clientAnswering(() => Response.json({ hits: [], more: false }));
  await client.searchConversations(USER, { query: "50% off_now" });
  await client.searchConversations(USER, { query: "garden", limit: 3, current: CURRENT });
  assert.equal(
    calls[0]!.url,
    "https://zaru.example/api/zaru-conversations/search?q=50%25+off_now",
  );
  assert.equal(
    calls[1]!.url,
    `https://zaru.example/api/zaru-conversations/search?q=garden&limit=3&current=${CURRENT}`,
  );
  assert.ok(calls.every((call) => bearerOf(call.init) === "Bearer aegis_key_abc"));
});

test("client: Zaru Web's own { error, message } is passed through with its status", async () => {
  const body = { error: "current_conversation", message: "That is the conversation we are in; it is already in front of you." };
  const { client } = clientAnswering(() => Response.json(body, { status: 409 }));
  assert.deepEqual(await client.readConversation(USER, { conversationId: CONVERSATION }), {
    ok: false,
    status: 409,
    refusal: body,
  });
});

test("client: an uncoded 401 is unauthorized, an uncoded 404 conversation_not_found, any other uncoded status unavailable", async () => {
  const cases: Array<[number, string]> = [
    [401, "unauthorized"],
    [404, "conversation_not_found"],
    [500, "unavailable"],
    [502, "unavailable"],
  ];
  const seen: Array<[number, string]> = [];
  for (const [status] of cases) {
    const { client } = clientAnswering(() => new Response("<html>nope</html>", { status }));
    const answer = (await client.listConversations(USER, {})) as Extract<
      ZaruConversationsAnswer,
      { ok: false }
    >;
    assert.equal(answer.ok, false);
    assert.equal(answer.status, status);
    assert.equal(
      answer.refusal.message,
      CONVERSATION_REFUSAL_MESSAGES[answer.refusal.error as keyof typeof CONVERSATION_REFUSAL_MESSAGES],
    );
    seen.push([status, answer.refusal.error]);
  }
  assert.deepEqual(seen, cases);
});

test("client: a 2xx that is not a JSON object throws", async () => {
  const { client } = clientAnswering(() => new Response("[]", { status: 200 }));
  await assert.rejects(client.listConversations(USER, {}), /without a JSON object/);
});

// ---------------------------------------------------------------------------
// The handlers: bad input refused before any fetch, a thrown fetch is
// unavailable, a refusal is a tool error whose text is { error, message }.
// ---------------------------------------------------------------------------

function errorOf(result: { content: Array<{ text: string }>; isError: boolean }): {
  error: string;
  message: string;
} {
  assert.equal(result.isError, true);
  return JSON.parse(result.content[0]!.text) as { error: string; message: string };
}

function recordingClient(answer: () => Promise<ZaruConversationsAnswer>) {
  const calls: Array<{ method: string; request: Record<string, unknown> }> = [];
  const make =
    (method: string) =>
    async (_user: ZaruUser, request: object): Promise<ZaruConversationsAnswer> => {
      calls.push({ method, request: { ...request } });
      return answer();
    };
  return {
    calls,
    client: {
      listConversations: make("list"),
      readConversation: make("read"),
      searchConversations: make("search"),
    },
  };
}

const OK = async (): Promise<ZaruConversationsAnswer> => ({ ok: true, output: { more: false } });

test("handlers: bad input is refused invalid_request before any fetch", async () => {
  const { handleZaruConversationsList, handleZaruConversationsRead, handleZaruConversationsSearch } =
    await handlers();
  const { client, calls } = recordingClient(OK);
  const refused: Array<[string, { content: Array<{ text: string }>; isError: boolean }]> = [
    ["list limit 0", await handleZaruConversationsList(client, USER, { limit: 0 })],
    ["list limit 51", await handleZaruConversationsList(client, USER, { limit: 51 })],
    ["list limit 2.5", await handleZaruConversationsList(client, USER, { limit: 2.5 })],
    ["list limit '5'", await handleZaruConversationsList(client, USER, { limit: "5" })],
    ["read no id", await handleZaruConversationsRead(client, USER, {})],
    ["read id not a UUID", await handleZaruConversationsRead(client, USER, { conversation_id: "../other" })],
    ["read page_size 101", await handleZaruConversationsRead(client, USER, { conversation_id: CONVERSATION, page_size: 101 })],
    ["read page_size 0", await handleZaruConversationsRead(client, USER, { conversation_id: CONVERSATION, page_size: 0 })],
    ["read cursor 7", await handleZaruConversationsRead(client, USER, { conversation_id: CONVERSATION, cursor: 7 })],
    ["search no query", await handleZaruConversationsSearch(client, USER, {})],
    ["search query 2", await handleZaruConversationsSearch(client, USER, { query: "ab" })],
    ["search query 201", await handleZaruConversationsSearch(client, USER, { query: "x".repeat(201) })],
    ["search limit 51", await handleZaruConversationsSearch(client, USER, { query: "garden", limit: 51 })],
  ];
  const wrong = refused
    .map(([label, result]) => {
      const code = result.isError
        ? (JSON.parse(result.content[0]!.text) as { error: string }).error
        : "answered";
      return [label, code] as const;
    })
    .filter(([, code]) => code !== "invalid_request");
  assert.deepEqual(
    { wrong, calls },
    { wrong: [], calls: [] },
    "every bad input is invalid_request, and none reaches Zaru Web",
  );
  for (const [label, result] of refused) {
    const { message } = errorOf(result);
    assert.ok(message.length > 0, `${label}: a sentence`);
    assert.ok(!RECORD_REFERENCE.test(message), `${label}: names no decision record: ${message}`);
  }
});

test("handlers: the bounds themselves are accepted and passed on, current only when the request named one", async () => {
  const { handleZaruConversationsList, handleZaruConversationsRead, handleZaruConversationsSearch } =
    await handlers();
  const { client, calls } = recordingClient(OK);
  await handleZaruConversationsList(client, USER, {});
  await handleZaruConversationsList(client, USER, { limit: 50 }, CURRENT);
  await handleZaruConversationsRead(client, USER, { conversation_id: CONVERSATION, page_size: 100, cursor: "c1" });
  await handleZaruConversationsSearch(client, USER, { query: "abc", limit: 1 }, CURRENT);
  assert.deepEqual(calls, [
    { method: "list", request: { limit: undefined, current: undefined } },
    { method: "list", request: { limit: 50, current: CURRENT } },
    {
      method: "read",
      request: { conversationId: CONVERSATION, cursor: "c1", pageSize: 100, current: undefined },
    },
    { method: "search", request: { query: "abc", limit: 1, current: CURRENT } },
  ]);
});

test("handlers: a fetch that throws (Zaru Web unreachable) is unavailable", async () => {
  const { handleZaruConversationsList, handleZaruConversationsRead, handleZaruConversationsSearch } =
    await handlers();
  const { client } = recordingClient(async () => {
    throw new TypeError("fetch failed");
  });
  const results = [
    await handleZaruConversationsList(client, USER, {}),
    await handleZaruConversationsRead(client, USER, { conversation_id: CONVERSATION }),
    await handleZaruConversationsSearch(client, USER, { query: "garden" }),
  ];
  for (const result of results) {
    assert.deepEqual(errorOf(result), {
      error: "unavailable",
      message: CONVERSATION_REFUSAL_MESSAGES.unavailable,
    });
  }
});

test("handlers: the client's refusal is the tool error's text, its fields unchanged", async () => {
  const { handleZaruConversationsList, handleZaruConversationsRead, handleZaruConversationsSearch } =
    await handlers();
  const refusal = { error: "conversation_not_found", message: "There is no conversation of yours with that id." };
  const { client } = recordingClient(async () => ({ ok: false, status: 404, refusal }));
  assert.deepEqual(
    errorOf(await handleZaruConversationsRead(client, USER, { conversation_id: CONVERSATION })),
    refusal,
  );
});

test("the refusal sentences of the conversation tools name no decision record", () => {
  for (const [code, sentence] of Object.entries(CONVERSATION_REFUSAL_MESSAGES)) {
    assert.ok(!RECORD_REFERENCE.test(sentence), `${code}: ${sentence}`);
  }
});

// ---------------------------------------------------------------------------
// Through the container's entrypoint.
// ---------------------------------------------------------------------------

const API_KEY = "aegis_conversation_tools_test_key";
const OTHER_PERSONS = "11111111-2222-4333-8444-555555555555";
const UNCODED_401 = "22222222-3333-4444-8555-666666666666";
const DROPPED = "33333333-4444-4555-8666-777777777777";

interface ZaruWebRequest {
  path: string;
  params: Record<string, string>;
  authorization: string | undefined;
}

let received: ZaruWebRequest[] = [];
let stub: Server;
let app: Server;
let base: string;

async function drain(req: IncomingMessage): Promise<void> {
  for await (const _chunk of req) void _chunk;
}

before(async () => {
  stub = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/v1/api-keys/validate" && req.method === "POST") {
      await drain(req);
      if (req.headers.authorization !== `Bearer ${API_KEY}`) {
        sendJson(401, { error: "invalid api key" });
        return;
      }
      sendJson(200, {
        user_id: "conversation-tools-test-user",
        tenant_id: null,
        aegis_role: null,
        zaru_tier: "pro",
        scopes: [],
      });
      return;
    }
    if (url.pathname === "/v1/seal/tools" && req.method === "GET") {
      sendJson(200, { tools: [] });
      return;
    }
    if (url.pathname.startsWith("/api/zaru-conversations/") && req.method === "GET") {
      received.push({
        path: url.pathname,
        params: Object.fromEntries(url.searchParams.entries()),
        authorization: req.headers.authorization,
      });
      const id = url.pathname.slice("/api/zaru-conversations/".length);
      if (id === OTHER_PERSONS) {
        sendJson(404, { error: "conversation_not_found", message: "There is no conversation of yours with that id." });
        return;
      }
      if (id === UNCODED_401) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (id === DROPPED) {
        req.socket.destroy();
        return;
      }
      if (id === "") {
        sendJson(200, { conversations: [{ id: CONVERSATION, current: url.searchParams.get("current") === CONVERSATION }], more: false });
        return;
      }
      if (id === "search") {
        sendJson(200, { hits: [], more: false });
        return;
      }
      sendJson(200, { conversation: { id }, messages: [], next_cursor: null });
      return;
    }
    sendJson(404, { error: "stub: no such route" });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  // auth.ts, orchestrator-client.ts and streamable-http.ts read these at
  // import time.
  process.env.AEGIS_ORCHESTRATOR_URL = stubUrl;
  process.env.ZARU_CLIENT_URL = stubUrl;
  process.env.JWKS_URI = `${stubUrl}/realms/zaru-consumer/protocol/openid-connect/certs`;
  delete process.env.AEGIS_TOOL_DISCOVERY_URL;
  delete process.env.BYPASS_AUTH;
  const { app: express } = await import("../src/app.js");
  await new Promise<void>((resolve) => {
    app = express.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

after(async () => {
  app?.closeAllConnections();
  await new Promise<void>((resolve) => app?.close(() => resolve()));
  stub?.closeAllConnections();
  await new Promise<void>((resolve) => stub?.close(() => resolve()));
});

let nextId = 1;

async function callTool(
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ content: Array<{ text: string }>; isError?: boolean; structuredContent?: unknown }> {
  const res = await fetch(`${base}/mcp/v1`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${API_KEY}`,
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  assert.equal(res.status, 200, `HTTP ${res.status}: ${await res.clone().text()}`);
  const answer = (await res.json()) as { result?: unknown };
  assert.ok(answer.result, `no result: ${JSON.stringify(answer)}`);
  return answer.result as { content: Array<{ text: string }>; isError?: boolean; structuredContent?: unknown };
}

test("entrypoint: each tool forwards the caller's key as Bearer to its route, with current only when the request carries x-zaru-conversation", async () => {
  received = [];
  const header = { "x-zaru-conversation": CURRENT };
  await callTool("zaru.conversations.list", { limit: 5 });
  await callTool("zaru.conversations.list", { limit: 5 }, header);
  await callTool("zaru.conversations.read", { conversation_id: CONVERSATION, page_size: 10 });
  await callTool("zaru.conversations.read", { conversation_id: CONVERSATION, cursor: "c1" }, header);
  await callTool("zaru.conversations.search", { query: "garden" });
  await callTool("zaru.conversations.search", { query: "garden", limit: 2 }, header);
  assert.deepEqual(received, [
    { path: "/api/zaru-conversations/", params: { limit: "5" }, authorization: `Bearer ${API_KEY}` },
    { path: "/api/zaru-conversations/", params: { limit: "5", current: CURRENT }, authorization: `Bearer ${API_KEY}` },
    { path: `/api/zaru-conversations/${CONVERSATION}`, params: { page_size: "10" }, authorization: `Bearer ${API_KEY}` },
    {
      path: `/api/zaru-conversations/${CONVERSATION}`,
      params: { cursor: "c1", current: CURRENT },
      authorization: `Bearer ${API_KEY}`,
    },
    { path: "/api/zaru-conversations/search", params: { q: "garden" }, authorization: `Bearer ${API_KEY}` },
    {
      path: "/api/zaru-conversations/search",
      params: { q: "garden", limit: "2", current: CURRENT },
      authorization: `Bearer ${API_KEY}`,
    },
  ]);
});

test("entrypoint: Zaru Web's answer is returned as text and structuredContent", async () => {
  const result = await callTool("zaru.conversations.list", {}, { "x-zaru-conversation": CONVERSATION });
  const expected = { conversations: [{ id: CONVERSATION, current: true }], more: false };
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content[0]!.text), expected);
  assert.deepEqual(result.structuredContent, expected);
});

test("entrypoint: a 404 is conversation_not_found, an uncoded 401 unauthorized, an unreachable Zaru Web unavailable", async () => {
  const codes = [];
  for (const id of [OTHER_PERSONS, UNCODED_401, DROPPED]) {
    const result = await callTool("zaru.conversations.read", { conversation_id: id });
    assert.equal(result.isError, true);
    codes.push((JSON.parse(result.content[0]!.text) as { error: string }).error);
  }
  assert.deepEqual(codes, ["conversation_not_found", "unauthorized", "unavailable"]);
});

test("entrypoint: bad input never reaches Zaru Web", async () => {
  received = [];
  const result = await callTool("zaru.conversations.search", { query: "ab" });
  assert.equal((JSON.parse(result.content[0]!.text) as { error: string }).error, "invalid_request");
  assert.deepEqual(received, [], "refused before Zaru Web");
});
