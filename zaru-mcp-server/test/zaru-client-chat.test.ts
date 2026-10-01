// ZaruClient.chat (Zaru ADR-0049 D2): the answers of Zaru Web's
// `POST /api/chat/turn` that the entrypoint tests of zaru-chat-shared.ts do
// not reach: a refusal whose body carries no code, and a 2xx whose body is
// not a JSON object.
import test from "node:test";
import assert from "node:assert/strict";

import { ZaruClient } from "../src/clients/zaru-client.js";
import type { ZaruUser } from "../src/middleware/auth.js";

const USER: ZaruUser = {
  userId: "user-1",
  tier: "pro",
  securityContext: "zaru-pro",
  token: "aegis_key_abc",
  isOperator: false,
};

function clientAnswering(response: Response): {
  client: ZaruClient;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new ZaruClient({
    baseUrl: "https://zaru.example/",
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return response;
    },
  });
  return { client, calls };
}

test("chat: POSTs JSON to /api/chat/turn with the caller's token as Bearer", async () => {
  const { client, calls } = clientAnswering(
    Response.json({ conversation_id: "c1", status: "complete" }),
  );
  const answer = await client.chat(USER, { message: "hi", mode: "chat" });
  assert.deepEqual(answer, {
    ok: true,
    output: { conversation_id: "c1", status: "complete" },
  });
  assert.equal(calls[0]?.url, "https://zaru.example/api/chat/turn");
  assert.equal(calls[0]?.init?.method, "POST");
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer aegis_key_abc");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(calls[0]?.init?.body, JSON.stringify({ message: "hi", mode: "chat" }));
});

test("chat: a refusal keeps every field Zaru Web sent beside its code and message", async () => {
  const { client } = clientAnswering(
    Response.json(
      { error: "turn_failed", message: "the model failed", conversation_id: "c2" },
      { status: 502 },
    ),
  );
  assert.deepEqual(await client.chat(USER, { message: "hi" }), {
    ok: false,
    status: 502,
    refusal: {
      error: "turn_failed",
      message: "the model failed",
      conversation_id: "c2",
    },
  });
});

test("chat: a 401 whose body carries no code is unauthorized; any other such status is turn_failed", async () => {
  const unauthorized = await clientAnswering(
    new Response("Unauthorized", { status: 401 }),
  ).client.chat(USER, { message: "hi" });
  assert.equal(unauthorized.ok, false);
  assert.equal(!unauthorized.ok && unauthorized.refusal.error, "unauthorized");

  const gateway = await clientAnswering(
    new Response("<html>bad gateway</html>", { status: 502 }),
  ).client.chat(USER, { message: "hi" });
  assert.equal(!gateway.ok && gateway.refusal.error, "turn_failed");
  assert.match(
    !gateway.ok ? gateway.refusal.message : "",
    /^Zaru Web answered 502: <html>bad gateway<\/html>$/,
  );
});

test("chat: a 2xx whose body is not a JSON object throws", async () => {
  await assert.rejects(
    clientAnswering(new Response("ok", { status: 200 })).client.chat(USER, {
      message: "hi",
    }),
    /answered 200 without a JSON object/,
  );
});
