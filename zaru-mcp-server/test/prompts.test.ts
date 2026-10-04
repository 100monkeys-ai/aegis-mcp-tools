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
    "zaru.memory.get",
    "zaru.memory.set",
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
    "zaru.memory.get",
    "zaru.memory.set",
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
  const result = getZaruInit(
    "operator",
    new Set(["chat-uploads"]),
    undefined,
    { isOperator: true, tier: "operator" },
  );
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

// ---------------------------------------------------------------------------
// Regression — the marker teaching MUST NOT contain any concrete example
// values. The previous teaching had a literal example
// "[Attached files this turn: 2 (application/pdf, image/png)]" which the
// LLM was treating as actual turn data, leading it to hallucinate "you have
// 2 PDFs and an image attached" on turns with no attachments at all.
//
// The teaching must describe the marker's SHAPE abstractly via placeholder
// syntax (<count>, <mime>) — never via literal MIME strings or counts that
// the LLM can confuse with live turn data.
// ---------------------------------------------------------------------------

test("chat-uploads teaching contains NO concrete MIME strings or example counts that an LLM could mistake for live turn data", () => {
  for (const mode of ["agentic", "workflow"] as const) {
    const result = getZaruInit(mode, new Set(["chat-uploads"]));
    assert.notEqual(result, null);
    const prompt = result!.system_prompt;

    // Extract just the augmented teaching segment so we don't accidentally
    // false-positive on substrings elsewhere in the base prompt.
    const teachingStart = prompt.indexOf(CHAT_UPLOADS_MARKER);
    assert.ok(
      teachingStart >= 0,
      `expected chat-uploads teaching to be present in '${mode}'`,
    );
    const teaching = prompt.slice(teachingStart);

    const forbiddenLiterals = [
      "application/pdf",
      "image/png",
      "image/jpeg",
      "application/json",
      "text/plain",
      "text/html",
      "application/octet-stream",
    ];
    for (const literal of forbiddenLiterals) {
      assert.ok(
        !teaching.includes(literal),
        `chat-uploads teaching for '${mode}' must NOT contain the concrete MIME string "${literal}" — describe the marker shape via placeholders only`,
      );
    }

    // No concrete numeric count inside the marker shape, e.g. `[Attached files this turn: 2`.
    assert.ok(
      !/\[Attached files this turn:\s*\d/.test(teaching),
      `chat-uploads teaching for '${mode}' must NOT contain a concrete numeric count inside the bracketed marker — use a <count> placeholder`,
    );

    // The placeholder shape MUST be present so the LLM knows the marker's structure.
    assert.ok(
      teaching.includes("<count>"),
      `chat-uploads teaching for '${mode}' must use a <count> placeholder for the marker shape`,
    );
    assert.ok(
      teaching.includes("<mime>"),
      `chat-uploads teaching for '${mode}' must use a <mime> placeholder for the marker shape`,
    );
  }
});

// ---------------------------------------------------------------------------
// Goals (Zaru ADR-0049 — Updates, the Update of 2026-10-04, G8; AEGIS
// ADR-131 D2): the agentic prompt gains one paragraph after "Step 4 — Report
// the result.", telling the model that a "Goal check" system message comes
// from Zaru. No other mode's prompt changes, and no mode's tool list offers
// a goal tool: goals are created and evaluated by Zaru Web's turn, never by
// the model.
// ---------------------------------------------------------------------------

/** G8's paragraph, verbatim from the record. */
const GOAL_CHECK_PARAGRAPH =
  'A system message headed "Goal check" comes from Zaru, not from the user. It names the executions already started for the user\'s goal and what the judge found missing. Continue from them: never start again an execution it lists as completed, read its result with aegis.task.wait or aegis.execution.file, and report what the user asked for.';

const ALL_MODES: Array<[string, ReturnType<typeof getZaruInit>]> = [
  ["chat", getZaruInit("chat")],
  ["agentic", getZaruInit("agentic")],
  ["workflow", getZaruInit("workflow")],
  ["execute", getZaruInit("execute")],
  ["live", getZaruInit("live", new Set(["live"]), "browser")],
  ["vibecode", getZaruInit("vibecode", new Set(["vibecode"]), "browser")],
  ["operator", getZaruInit("operator", new Set(), undefined, { isOperator: true, tier: "operator" })],
];

test("G8: the agentic prompt holds the Goal check paragraph verbatim, after Step 4's text and before Step 5", () => {
  for (const caps of [new Set<string>(), new Set(["chat-uploads"])]) {
    const prompt = getZaruInit("agentic", caps)!.system_prompt;
    const step4 = prompt.indexOf("**Step 4 — Report the result.**");
    const at = prompt.indexOf(GOAL_CHECK_PARAGRAPH);
    const step5 = prompt.indexOf("**Step 5 — Retrieve files if mentioned.**");
    assert.ok(step4 >= 0 && step5 > step4, "the agentic prompt has Step 4 then Step 5");
    assert.ok(at > step4, "the Goal check paragraph is in the agentic prompt, after Step 4");
    assert.ok(at < step5, "the Goal check paragraph comes before Step 5");
    // Step 4's own text ends, then a blank line, then the paragraph, then a
    // blank line, then Step 5: the paragraph stands on its own.
    assert.equal(
      prompt.slice(at - 2, at + GOAL_CHECK_PARAGRAPH.length + 2),
      `\n\n${GOAL_CHECK_PARAGRAPH}\n\n`,
    );
    assert.equal(prompt.split(GOAL_CHECK_PARAGRAPH).length, 2, "the paragraph appears once");
    assert.ok(
      prompt.slice(step4, at).includes("Never call aegis.task.logs just to retrieve output that is already in `last_output`."),
      "Step 4's text is whole before the paragraph",
    );
  }
});

test("G8: no other mode's prompt holds the Goal check paragraph or the words Goal check", () => {
  for (const [mode, init] of ALL_MODES) {
    assert.ok(init, `getZaruInit('${mode}') answers`);
    if (mode === "agentic") continue;
    assert.ok(!init.system_prompt.includes("Goal check"), `'${mode}' prompt must not mention Goal check`);
  }
});

test("G8: the paragraph names no tool outside the agentic mode's tool list", () => {
  const agentic = getZaruInit("agentic")!;
  const named = GOAL_CHECK_PARAGRAPH.match(/\b(?:aegis|zaru)(?:\.[a-z_]+)+/g) ?? [];
  assert.deepEqual(named, ["aegis.task.wait", "aegis.execution.file"]);
  for (const tool of named) {
    assert.ok(agentic.available_tools.includes(tool), `${tool} is in the agentic tool list`);
  }
  assert.ok(!/aegis\.goal\./.test(GOAL_CHECK_PARAGRAPH), "the paragraph names no goal tool");
});

test("AEGIS ADR-131 D2 / G2: no mode's tool list offers a goal tool", () => {
  for (const [mode, init] of ALL_MODES) {
    const goalTools = init!.available_tools.filter((t) => t.startsWith("aegis.goal."));
    assert.deepEqual(goalTools, [], `'${mode}' must not list a goal tool`);
  }
});
