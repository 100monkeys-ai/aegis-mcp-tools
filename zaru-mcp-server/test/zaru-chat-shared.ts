// The tests of `zaru.chat` through an entrypoint, and a loopback stub of the
// two upstreams `zaru.chat` touches, shared by
// zaru-chat.test.ts (the container's Express app) and
// zaru-chat.worker.test.ts (the Workers entrypoint): the orchestrator (API-key
// validation, SEAL tool discovery, attest and invoke) and Zaru Web's
// `POST /api/chat/turn` (Zaru ADR-0049 D2).
//
// The turn route is stubbed from the record's words, since it is not on
// zaru-client's main yet: its request is `{ message, conversationId?, mode? }`
// with the caller's token as Bearer; its answer is D1's output object as JSON,
// or a refusal `{ error: <code>, message: <text> }` with an HTTP status.
// What the stub answers is chosen by the message:
//   CONFLICT_MESSAGE      409 active_execution_exists
//   UNAUTHORIZED_MESSAGE  401 unauthorized
//   DROP_MESSAGE          the connection is destroyed: Zaru Web unreachable
//   anything else         200 with D1's output object
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const API_KEY = "aegis_zaru_chat_test_key";
export const STUB_TOOL = "aegis.stub.echo";
export const NEW_CONVERSATION_ID = "5d1c2b7a-3e4f-4a6b-9c8d-0e1f2a3b4c5d";
export const STUB_MODEL = "@cf/deepseek-ai/deepseek-v4-flash-0731";

export const CONFLICT_MESSAGE = "stub: answer 409";
export const UNAUTHORIZED_MESSAGE = "stub: answer 401";
export const DROP_MESSAGE = "stub: drop the connection";

export interface TurnRequest {
  authorization: string | undefined;
  contentType: string | undefined;
  body: Record<string, unknown>;
}

export interface ChatStub {
  url: string;
  /** Every POST /api/chat/turn the stub received, in order. */
  turns: TurnRequest[];
  /** The tool name of every SEAL invoke the stub received, in order. */
  invoked: string[];
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

/** D1's output object for a turn that completed. */
export function turnOutput(body: Record<string, unknown>): Record<string, unknown> {
  return {
    conversation_id:
      typeof body.conversationId === "string"
        ? body.conversationId
        : NEW_CONVERSATION_ID,
    status: "complete",
    answer: `stub answer to: ${String(body.message)}`,
    tool_calls: [],
    model: STUB_MODEL,
    mode: typeof body.mode === "string" ? body.mode : "chat",
    usage: { prompt_tokens: 12, completion_tokens: 7 },
  };
}

export async function startChatStub(): Promise<ChatStub> {
  const turns: TurnRequest[] = [];
  const invoked: string[] = [];

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
        user_id: "zaru-chat-test-user",
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
            name: STUB_TOOL,
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
        payload: { id: unknown; params?: { name?: unknown } };
      };
      invoked.push(String(envelope.payload.params?.name));
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
    if (url.pathname === "/api/chat/turn" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      turns.push({
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body,
      });
      if (body.message === CONFLICT_MESSAGE) {
        sendJson(409, {
          error: "active_execution_exists",
          message: "A turn is already running in this conversation",
        });
        return;
      }
      if (body.message === UNAUTHORIZED_MESSAGE) {
        sendJson(401, {
          error: "unauthorized",
          message: "A valid API key or session is required",
        });
        return;
      }
      if (body.message === DROP_MESSAGE) {
        req.socket.destroy();
        return;
      }
      sendJson(200, turnOutput(body));
      return;
    }
    sendJson(404, { error: "stub: no such route" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    turns,
    invoked,
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

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

let nextId = 100;

async function rpc(
  post: McpPost,
  method: string,
  params: unknown,
  headers?: Record<string, string>,
): Promise<{ result?: unknown; error?: { message: string } }> {
  const res = await post(
    { jsonrpc: "2.0", id: nextId++, method, params },
    {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${API_KEY}`,
      ...headers,
    },
  );
  assert.equal(res.status, 200, `HTTP ${res.status}: ${await res.clone().text()}`);
  return (await res.json()) as { result?: unknown; error?: { message: string } };
}

async function callTool(
  post: McpPost,
  name: string,
  args: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<ToolResult> {
  const answer = await rpc(post, "tools/call", { name, arguments: args }, headers);
  assert.ok(answer.result, `no result: ${JSON.stringify(answer)}`);
  return answer.result as ToolResult;
}

/**
 * Registers the tests of `zaru.chat` (Zaru ADR-0049 D1, D2 and D6) against
 * one entrypoint. `context` is read when each test runs, after the file's
 * `before` has started the stub and the entrypoint.
 */
export function registerZaruChatTests(
  label: string,
  context: () => { post: McpPost; stub: ChatStub },
): void {
  test(`${label}: tools/list includes zaru.chat with D1's input schema`, async () => {
    const { post } = context();
    const answer = await rpc(post, "tools/list", {});
    const tools = (answer.result as { tools: Array<Record<string, unknown>> })
      .tools;
    const chat = tools.find((t) => t.name === "zaru.chat");
    assert.ok(chat, `tools: ${tools.map((t) => t.name).join(", ")}`);
    assert.equal(typeof chat.description, "string");
    // Zaru ADR-0049's Update, G10 and H16: an agentic turn whose answer
    // carries `goal` is judged and continued by Zaru after the call, so the
    // caller sends no "keep going" and reads the goal's state, not `status`.
    const description = chat.description as string;
    for (const phrase of [
      "when the answer carries goal",
      'send no "keep going"',
      "aegis.goal.status",
      "whether the work is done is the goal's state",
      "usage?, goal? }",
    ]) {
      assert.ok(description.includes(phrase), `missing: ${phrase}`);
    }
    for (const phrase of [
      "everything done so far stored; send your next message",
      "usage? }.",
    ]) {
      assert.ok(!description.includes(phrase), `still there: ${phrase}`);
    }
    const schema = chat.inputSchema as {
      type: string;
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["message"]);
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      "conversation_id",
      "message",
      "mode",
    ]);
    assert.equal(schema.properties.message?.type, "string");
    assert.equal(schema.properties.message?.minLength, 1);
    assert.equal(schema.properties.message?.maxLength, 32768);
    assert.equal(schema.properties.conversation_id?.type, "string");
    assert.equal(schema.properties.conversation_id?.format, "uuid");
    assert.equal(schema.properties.mode?.type, "string");
    assert.deepEqual(schema.properties.mode?.enum, [
      "chat",
      "agentic",
      "workflow",
      "execute",
    ]);
    // The orchestrator's tools are listed as before.
    assert.ok(tools.some((t) => t.name === STUB_TOOL));
  });

  test(`${label}: a call posts message, conversationId and mode to Zaru Web with the caller's token, and returns its JSON as text and structuredContent`, async () => {
    const { post, stub } = context();
    const before = stub.turns.length;
    const args = {
      message: "Say hello in one sentence.",
      conversation_id: "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0",
      mode: "agentic",
    };
    const result = await callTool(post, "zaru.chat", args);
    assert.equal(stub.turns.length, before + 1, "one POST /api/chat/turn");
    const turn = stub.turns[before]!;
    assert.equal(turn.authorization, `Bearer ${API_KEY}`);
    assert.match(turn.contentType ?? "", /^application\/json/);
    assert.deepEqual(turn.body, {
      message: args.message,
      conversationId: args.conversation_id,
      mode: args.mode,
    });
    const expected = turnOutput(turn.body);
    assert.equal(result.isError, false, result.content[0]?.text);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0]?.type, "text");
    assert.deepEqual(JSON.parse(result.content[0]!.text), expected);
    assert.deepEqual(result.structuredContent, expected);
  });

  test(`${label}: a call with only a message sends neither conversationId nor mode`, async () => {
    const { post, stub } = context();
    const before = stub.turns.length;
    const result = await callTool(post, "zaru.chat", { message: "Hello." });
    assert.equal(result.isError, false, result.content[0]?.text);
    assert.deepEqual(stub.turns[before]?.body, { message: "Hello." });
    assert.equal(
      (result.structuredContent as { conversation_id: string }).conversation_id,
      NEW_CONVERSATION_ID,
    );
  });

  test(`${label}: a 409 from Zaru Web is a tool error with active_execution_exists`, async () => {
    const { post } = context();
    const result = await callTool(post, "zaru.chat", {
      message: CONFLICT_MESSAGE,
    });
    assert.equal(result.isError, true);
    const refusal = JSON.parse(result.content[0]!.text) as {
      error: string;
      message: string;
    };
    assert.equal(refusal.error, "active_execution_exists");
    assert.equal(
      refusal.message,
      "A turn is already running in this conversation",
    );
  });

  test(`${label}: a 401 from Zaru Web is a tool error with its code`, async () => {
    const { post } = context();
    const result = await callTool(post, "zaru.chat", {
      message: UNAUTHORIZED_MESSAGE,
    });
    assert.equal(result.isError, true);
    const refusal = JSON.parse(result.content[0]!.text) as { error: string };
    assert.equal(refusal.error, "unauthorized");
  });

  test(`${label}: an unreachable Zaru Web is a tool error with turn_failed`, async () => {
    const { post } = context();
    const result = await callTool(post, "zaru.chat", { message: DROP_MESSAGE });
    assert.equal(result.isError, true);
    const refusal = JSON.parse(result.content[0]!.text) as {
      error: string;
      message: string;
    };
    assert.equal(refusal.error, "turn_failed");
    assert.equal(typeof refusal.message, "string");
  });

  test(`${label}: a request carrying x-zaru-turn is refused without a fetch`, async () => {
    const { post, stub } = context();
    const turnsBefore = stub.turns.length;
    const invokedBefore = stub.invoked.length;
    const result = await callTool(
      post,
      "zaru.chat",
      { message: "Call yourself." },
      { "x-zaru-turn": "1" },
    );
    assert.equal(result.isError, true);
    const refusal = JSON.parse(result.content[0]!.text) as { error: string };
    assert.equal(refusal.error, "mode_not_available");
    assert.equal(stub.turns.length, turnsBefore, "no POST /api/chat/turn");
    assert.equal(stub.invoked.length, invokedBefore, "no SEAL invoke");
  });

  test(`${label}: zaru.chat is never passed to the orchestrator's tool invocation`, async () => {
    const { post, stub } = context();
    await callTool(post, "zaru.chat", { message: "Hello again." });
    await callTool(post, "zaru.chat", { message: CONFLICT_MESSAGE });
    assert.ok(
      !stub.invoked.includes("zaru.chat"),
      `invoked: ${stub.invoked.join(", ")}`,
    );
  });

  test(`${label}: the other tools are forwarded to the orchestrator as before, with or without x-zaru-turn`, async () => {
    const { post, stub } = context();
    const before = stub.invoked.length;
    const plain = await callTool(post, STUB_TOOL, {});
    assert.equal(plain.content[0]?.text, `invoked: ${STUB_TOOL}`);
    const inTurn = await callTool(post, STUB_TOOL, {}, { "x-zaru-turn": "1" });
    assert.equal(inTurn.content[0]?.text, `invoked: ${STUB_TOOL}`);
    assert.deepEqual(stub.invoked.slice(before), [STUB_TOOL, STUB_TOOL]);
  });
}
