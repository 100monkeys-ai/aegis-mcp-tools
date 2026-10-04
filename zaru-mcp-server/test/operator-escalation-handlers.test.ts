// The handlers of zaru.operator.escalate and zaru.operator.release (Zaru
// ADR-0050 D3, D4, and the record's Update of 2026-10-04 U1 to U3), against
// a fake orchestrator client.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ZARU_OPERATOR_ESCALATE_TOOL,
  ZARU_OPERATOR_RELEASE_TOOL,
  handleOperatorEscalate,
  handleOperatorRelease,
} from "../src/mcp/streamable-http.js";
import type { OperatorEscalationAnswer } from "../src/mcp/orchestrator-client.js";

const user = {
  userId: "5a1e0000-consumer",
  tier: "pro",
  securityContext: "zaru-pro",
  token: "aegis_operator_consumer_key",
  isOperator: false,
};

function fakeClient(answer: OperatorEscalationAnswer) {
  const redeemed: string[] = [];
  let released = 0;
  return {
    redeemed,
    released: () => released,
    async redeemOperatorEscalation(_user: unknown, code: string) {
      redeemed.push(code);
      return answer;
    },
    async releaseOperatorEscalation() {
      released += 1;
      return answer;
    },
  };
}

test("the escalate listing takes one code of six decimal digits (D3)", () => {
  assert.equal(ZARU_OPERATOR_ESCALATE_TOOL.name, "zaru.operator.escalate");
  assert.deepEqual(ZARU_OPERATOR_ESCALATE_TOOL.inputSchema.required, ["code"]);
  assert.equal(
    ZARU_OPERATOR_ESCALATE_TOOL.inputSchema.properties.code.pattern,
    "^[0-9]{6}$",
  );
  assert.match(ZARU_OPERATOR_ESCALATE_TOOL.description, /never guess/i);
  assert.equal(ZARU_OPERATOR_RELEASE_TOOL.name, "zaru.operator.release");
  assert.deepEqual(ZARU_OPERATOR_RELEASE_TOOL.inputSchema.properties, {});
});

test("a well-formed code is posted and the escalation's role and end returned (D3)", async () => {
  const client = fakeClient({
    ok: true,
    body: { aegis_role: "aegis:operator", expires_at: "2026-10-04T07:00:00Z" },
  });
  const result = await handleOperatorEscalate(client, user, { code: "042917" });
  assert.deepEqual(client.redeemed, ["042917"]);
  assert.equal(result.isError, false);
  const expected = {
    aegis_role: "aegis:operator",
    expires_at: "2026-10-04T07:00:00Z",
  };
  assert.deepEqual(JSON.parse(result.content[0]!.text), expected);
  assert.deepEqual(result.structuredContent, expected);
});

test("a code that is not six decimal digits is refused invalid_code and never sent (Update U3)", async () => {
  const client = fakeClient({ ok: true, body: {} });
  for (const args of [
    { code: "12345" },
    { code: "1234567" },
    { code: "12a456" },
    { code: " 123456" },
    { code: "１２３４５６" },
    { code: 123456 },
    {},
    undefined,
  ]) {
    const result = await handleOperatorEscalate(client, user, args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(
      JSON.parse(result.content[0]!.text).error,
      "invalid_code",
      JSON.stringify(args),
    );
  }
  assert.deepEqual(client.redeemed, []);
});

test("the orchestrator's refusal is relayed unchanged (Update U1)", async () => {
  for (const refusal of [
    { error: "invalid_code", message: "the code is not valid for this key" },
    { error: "code_expired", message: "the code has expired; generate a new one" },
    {
      error: "escalation_requires_api_key",
      message: "only an API key can hold an operator escalation",
    },
    { error: "orchestrator_unavailable", message: "HTTP 502" },
  ]) {
    const result = await handleOperatorEscalate(
      fakeClient({ ok: false, refusal }),
      user,
      { code: "123456" },
    );
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0]!.text), refusal);
  }
});

test("release returns the end, or relays the refusal (D4, Update U1)", async () => {
  const ended = fakeClient({ ok: true, body: { ended_at: "2026-10-04T06:40:00Z" } });
  const result = await handleOperatorRelease(ended, user);
  assert.equal(ended.released(), 1);
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content[0]!.text), {
    ended_at: "2026-10-04T06:40:00Z",
  });

  const refusal = {
    error: "escalation_not_found",
    message: "this key holds no active escalation",
  };
  const none = await handleOperatorRelease(fakeClient({ ok: false, refusal }), user);
  assert.equal(none.isError, true);
  assert.deepEqual(JSON.parse(none.content[0]!.text), refusal);
});
