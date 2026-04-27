import test from "node:test";
import assert from "node:assert/strict";

import { getZaruInit, ZARU_VERSION } from "../src/prompts/index.js";

// ---------------------------------------------------------------------------
// vibecode mode — capability gate
// ---------------------------------------------------------------------------

test("getZaruInit('vibecode') returns a full response for a browser client with the 'vibecode' capability", () => {
  const result = getZaruInit("vibecode", new Set(["vibecode"]), "browser");

  assert.notEqual(result, null, "expected a non-null response");
  assert.equal(result!.mode, "vibecode");
  assert.equal(result!.version, ZARU_VERSION);
  assert.ok(
    typeof result!.system_prompt === "string" &&
      result!.system_prompt.length > 0,
    "system_prompt should be a non-empty string",
  );
  assert.deepEqual(result!.available_tools, [
    "zaru.mode",
    "zaru.docs",
    "zaru.execute_typescript",
    "zaru.script.save",
    "zaru.script.run",
  ]);
});

test("getZaruInit('vibecode') returns null when no client is supplied", () => {
  const result = getZaruInit("vibecode");
  assert.equal(result, null);
});

test("getZaruInit('vibecode') returns null for a browser client without the 'vibecode' capability", () => {
  const result = getZaruInit("vibecode", new Set(), "browser");
  assert.equal(result, null);
});

test("getZaruInit('vibecode') returns null for a non-browser client even with the 'vibecode' capability", () => {
  const result = getZaruInit("vibecode", new Set(["vibecode"]), "cli");
  assert.equal(result, null);
});

test("getZaruInit('vibecode') returns null when a browser client only advertises the 'live' capability", () => {
  const result = getZaruInit("vibecode", new Set(["live"]), "browser");
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// live mode — symmetric capability-gate coverage
// ---------------------------------------------------------------------------

test("getZaruInit('live') returns a full response for a browser client with the 'live' capability", () => {
  const result = getZaruInit("live", new Set(["live"]), "browser");

  assert.notEqual(result, null);
  assert.equal(result!.mode, "live");
  assert.equal(result!.version, ZARU_VERSION);
  assert.ok(result!.system_prompt.length > 0);
  assert.deepEqual(result!.available_tools, [
    "zaru.mode",
    "zaru.docs",
    "zaru.execute_typescript",
    "zaru.script.save",
    "zaru.script.run",
  ]);
});

test("getZaruInit('live') returns null when the 'live' capability is missing", () => {
  assert.equal(getZaruInit("live"), null);
  assert.equal(getZaruInit("live", new Set(), "browser"), null);
  assert.equal(getZaruInit("live", new Set(["live"]), "cli"), null);
});

// ---------------------------------------------------------------------------
// default mode — no gating
// ---------------------------------------------------------------------------

test("getZaruInit() with no arguments returns the 'chat' response", () => {
  const result = getZaruInit();
  assert.notEqual(result, null);
  assert.equal(result!.mode, "chat");
  assert.equal(result!.version, ZARU_VERSION);
});

test("getZaruInit('nonexistent') returns null", () => {
  const result = getZaruInit("nonexistent");
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// chat-uploads capability — additive system prompt teaching for agentic /
// workflow modes (ADR-113).
// ---------------------------------------------------------------------------

const CHAT_UPLOADS_MARKER =
  "CHAT ATTACHMENTS — UPLOADED FILES ARE HANDLED FOR YOU";
const CHAT_UPLOADS_NEVER_ASK_MARKER = "NEVER ask the user";
const CHAT_UPLOADS_TOOL_MARKER = "aegis.attachment.read";

test("getZaruInit('agentic') with the 'chat-uploads' capability augments the system prompt with attachment teaching", () => {
  const withCap = getZaruInit("agentic", new Set(["chat-uploads"]));
  assert.notEqual(withCap, null);
  assert.ok(
    withCap!.system_prompt.includes(CHAT_UPLOADS_MARKER),
    "expected agentic prompt to include attachment pass-through teaching",
  );
  assert.ok(
    withCap!.system_prompt.includes("attachments"),
    "expected the prompt to mention the `attachments` field",
  );
});

test("getZaruInit('agentic') WITHOUT the 'chat-uploads' capability returns the base prompt", () => {
  const withoutCap = getZaruInit("agentic");
  assert.notEqual(withoutCap, null);
  assert.ok(
    !withoutCap!.system_prompt.includes(CHAT_UPLOADS_MARKER),
    "expected base agentic prompt to omit attachment teaching",
  );

  const emptyCaps = getZaruInit("agentic", new Set());
  assert.notEqual(emptyCaps, null);
  assert.ok(!emptyCaps!.system_prompt.includes(CHAT_UPLOADS_MARKER));

  const otherCap = getZaruInit("agentic", new Set(["live"]));
  assert.notEqual(otherCap, null);
  assert.ok(!otherCap!.system_prompt.includes(CHAT_UPLOADS_MARKER));
});

test("getZaruInit('workflow') with the 'chat-uploads' capability augments the system prompt", () => {
  const withCap = getZaruInit("workflow", new Set(["chat-uploads"]));
  assert.notEqual(withCap, null);
  assert.ok(withCap!.system_prompt.includes(CHAT_UPLOADS_MARKER));
});

test("getZaruInit('workflow') WITHOUT the 'chat-uploads' capability returns the base prompt", () => {
  const withoutCap = getZaruInit("workflow");
  assert.notEqual(withoutCap, null);
  assert.ok(!withoutCap!.system_prompt.includes(CHAT_UPLOADS_MARKER));
});

test("getZaruInit('chat') with 'chat-uploads' does NOT inject attachment teaching (chat is non-dispatching)", () => {
  const result = getZaruInit("chat", new Set(["chat-uploads"]));
  assert.notEqual(result, null);
  assert.ok(!result!.system_prompt.includes(CHAT_UPLOADS_MARKER));
});

test("getZaruInit('execute') with 'chat-uploads' does NOT inject attachment teaching", () => {
  const result = getZaruInit("execute", new Set(["chat-uploads"]));
  assert.notEqual(result, null);
  assert.ok(!result!.system_prompt.includes(CHAT_UPLOADS_MARKER));
});

test("getZaruInit('live') with 'chat-uploads' + 'live' does NOT inject attachment teaching", () => {
  const result = getZaruInit(
    "live",
    new Set(["live", "chat-uploads"]),
    "browser",
  );
  assert.notEqual(result, null);
  assert.ok(!result!.system_prompt.includes(CHAT_UPLOADS_MARKER));
});

test("getZaruInit('vibecode') with 'chat-uploads' + 'vibecode' does NOT inject attachment teaching", () => {
  const result = getZaruInit(
    "vibecode",
    new Set(["vibecode", "chat-uploads"]),
    "browser",
  );
  assert.notEqual(result, null);
  assert.ok(!result!.system_prompt.includes(CHAT_UPLOADS_MARKER));
});

test("getZaruInit('operator') with 'chat-uploads' does NOT inject attachment teaching", () => {
  const result = getZaruInit("operator", new Set(["chat-uploads"]));
  assert.notEqual(result, null);
  assert.ok(!result!.system_prompt.includes(CHAT_UPLOADS_MARKER));
});

// ---------------------------------------------------------------------------
// chat-uploads teaching content — explicit "do not solicit" + tool-name rules
// ---------------------------------------------------------------------------

test("getZaruInit('agentic') with 'chat-uploads' forbids soliciting file content from the user", () => {
  const result = getZaruInit("agentic", new Set(["chat-uploads"]));
  assert.notEqual(result, null);
  assert.ok(
    result!.system_prompt.includes(CHAT_UPLOADS_NEVER_ASK_MARKER),
    "expected the prompt to contain a 'NEVER ask the user' rule preventing solicitation of content / URLs when a file was attached",
  );
});

test("getZaruInit('agentic') with 'chat-uploads' names aegis.attachment.read as the read tool", () => {
  const result = getZaruInit("agentic", new Set(["chat-uploads"]));
  assert.notEqual(result, null);
  assert.ok(
    result!.system_prompt.includes(CHAT_UPLOADS_TOOL_MARKER),
    "expected the prompt to mention `aegis.attachment.read` so dispatched agents know which tool to use",
  );
});

test("getZaruInit('workflow') with 'chat-uploads' includes both the 'never ask' rule and aegis.attachment.read", () => {
  const result = getZaruInit("workflow", new Set(["chat-uploads"]));
  assert.notEqual(result, null);
  assert.ok(result!.system_prompt.includes(CHAT_UPLOADS_NEVER_ASK_MARKER));
  assert.ok(result!.system_prompt.includes(CHAT_UPLOADS_TOOL_MARKER));
});

test("getZaruInit('agentic') WITHOUT 'chat-uploads' does NOT contain the new teaching phrases (capability still gates them)", () => {
  const result = getZaruInit("agentic");
  assert.notEqual(result, null);
  assert.ok(
    !result!.system_prompt.includes(CHAT_UPLOADS_NEVER_ASK_MARKER),
    "the 'NEVER ask the user' phrase must not leak into the base agentic prompt",
  );
  assert.ok(
    !result!.system_prompt.includes(CHAT_UPLOADS_TOOL_MARKER),
    "the aegis.attachment.read mention must not leak into the base agentic prompt",
  );
});

// ---------------------------------------------------------------------------
// Per-turn attachments marker — Zaru's chat-side LLM cannot see the
// `attachments` array (the chat client injects it deterministically AFTER
// tool-call selection), so the teaching must reference the bracketed
// "[Attached files this turn: N (...)]" marker that DOES appear in the
// LLM's view of the user's current turn. Without this, the prompt would
// instruct Zaru to gate behavior on a field it cannot read.
// ---------------------------------------------------------------------------

const CHAT_UPLOADS_MARKER_SUBSTRING = "[Attached files this turn:";

test("getZaruInit('agentic') with 'chat-uploads' references the per-turn '[Attached files this turn:' marker", () => {
  const result = getZaruInit("agentic", new Set(["chat-uploads"]));
  assert.notEqual(result, null);
  assert.ok(
    result!.system_prompt.includes(CHAT_UPLOADS_MARKER_SUBSTRING),
    "expected the agentic prompt to teach Zaru about the bracketed per-turn marker its chat-side LLM actually sees",
  );
});

test("getZaruInit('workflow') with 'chat-uploads' references the per-turn '[Attached files this turn:' marker", () => {
  const result = getZaruInit("workflow", new Set(["chat-uploads"]));
  assert.notEqual(result, null);
  assert.ok(
    result!.system_prompt.includes(CHAT_UPLOADS_MARKER_SUBSTRING),
    "expected the workflow prompt to teach Zaru about the bracketed per-turn marker its chat-side LLM actually sees",
  );
});

test("getZaruInit('agentic') WITHOUT 'chat-uploads' does NOT mention the per-turn marker", () => {
  const result = getZaruInit("agentic");
  assert.notEqual(result, null);
  assert.ok(
    !result!.system_prompt.includes(CHAT_UPLOADS_MARKER_SUBSTRING),
    "the per-turn marker reference must be gated by the chat-uploads capability",
  );
});
