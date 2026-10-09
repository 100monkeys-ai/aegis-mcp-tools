import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

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
    const step5 = prompt.indexOf("**Step 5 — Files the run made.**");
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

test("AEGIS ADR-131 D2 / G2, U33: no mode's tool list offers a goal tool but aegis.goal.cancel", () => {
  for (const [mode, init] of ALL_MODES) {
    const goalTools = init!.available_tools.filter(
      (t) => t.startsWith("aegis.goal.") && t !== "aegis.goal.cancel",
    );
    assert.deepEqual(goalTools, [], `'${mode}' must not list a goal tool other than aegis.goal.cancel`);
  }
});

// ---------------------------------------------------------------------------
// Chat mode: the mode decision comes first (Zaru ADR-0028 W41). A reasoning
// model in Chat mode was handed a multi-vehicle routing problem and spent its
// whole output on working it out, with no text and no zaru.mode call: the
// prompt's rules for when to switch named no request that needs exact
// computation at scale, and told the model it could not call tools at all.
// The decision now opens Chat mode's own text, its criteria named by kind.
// These tests pin the text; whether the model obeys it is proved on the live
// page, not here.
// ---------------------------------------------------------------------------

const MODE_DECISION_HEADING = "# FIRST, DECIDE WHERE THIS BELONGS";

/** The shared personality, read from the agentic prompt: the text before its first own section. */
function sharedPersonality(): string {
  const agentic = getZaruInit("agentic")!.system_prompt;
  return agentic.slice(0, agentic.indexOf("\n\n# TOOL USE — MANDATORY RULES"));
}

/** Chat mode's own text: everything after the shared personality. */
function chatOwnText(): string {
  const chat = getZaruInit("chat")!.system_prompt;
  const personality = sharedPersonality();
  assert.ok(chat.startsWith(personality), "the chat prompt opens with the shared personality");
  return chat.slice(personality.length);
}

/** The mode decision section: from its heading to the next top-level heading. */
function modeDecisionSection(): string {
  const own = chatOwnText();
  const start = own.indexOf(MODE_DECISION_HEADING);
  assert.ok(start >= 0, "the chat prompt holds the mode decision section");
  const next = own.indexOf("\n# ", start + MODE_DECISION_HEADING.length);
  return own.slice(start, next < 0 ? undefined : next);
}

test("W41: Chat mode's own text opens with the mode decision, before any other guidance", () => {
  const own = chatOwnText();
  assert.equal(
    own.indexOf(MODE_DECISION_HEADING),
    2,
    "the mode decision is the first section after the shared personality",
  );
  const section = modeDecisionSection();
  const afterSection = own.indexOf(section) + section.length;
  for (const later of ["# IN THIS CONVERSATION", "workflow", "execute"]) {
    const at = own.indexOf(later);
    assert.ok(at < 0 || at >= afterSection, `'${later}' comes after the mode decision`);
  }
  assert.ok(
    /decide[^.]*before you (?:work|plan|solve)/i.test(section),
    "the section tells the model to decide before working anything out",
  );
});

test("W41: the decision tells the model to call zaru.mode with agentic as its first act", () => {
  const section = modeDecisionSection();
  assert.ok(section.includes("call zaru.mode"), "names the call");
  assert.ok(section.includes('mode "agentic"'), "names the target mode");
  assert.ok(/first act/i.test(section), "the call is the first act");
});

test("W41: the criteria for Agentic are named by kind", () => {
  const section = modeDecisionSection().toLowerCase();
  const kinds: Array<[string, RegExp]> = [
    ["exact computation", /exact computation/],
    ["search over many constraints", /search over many/],
    ["routing", /routing/],
    ["scheduling", /scheduling/],
    ["optimisation", /optimi[sz]ation/],
    ["code to write or run", /code to write[^\n]*run/],
    ["files to read or produce", /files to read[^\n]*produce/],
    ["tools or the web", /the web/],
    ["several steps", /several steps/],
    ["minutes of work", /minute/],
    ["checked or iterated", /checked[^\n]*(?:rerun|improved|iterat)/],
  ];
  for (const [name, pattern] of kinds) {
    assert.ok(pattern.test(section), `the criteria name ${name}`);
  }
});

test("W41: plain questions, conversation, planning and advice stay in Chat", () => {
  const section = modeDecisionSection().toLowerCase();
  assert.ok(/stay in chat/.test(section), "says what stays in Chat");
  for (const kind of ["question", "conversation", "planning", "advice"]) {
    assert.ok(section.includes(kind), `'${kind}' stays in Chat`);
  }
});

test("W41: when unsure and a wrong guess means a failed answer, the switch is proposed", () => {
  const section = modeDecisionSection().toLowerCase();
  assert.ok(/unsure[^.]*fail/.test(section), "the unsure rule names the failed answer");
  assert.ok(/never start solving/.test(section), "the model does not start solving to find out");
});

test("W41: the reason shown to the person is plain, and the example reason carries no jargon", () => {
  const section = modeDecisionSection();
  assert.ok(/one or two plain sentences/i.test(section), "the reason is one or two plain sentences");
  assert.ok(/do not mention tokens, limits/i.test(section), "the reason never mentions tokens or limits");
  const example = section.match(/For example: "([^"]+)"/);
  assert.ok(example, "the section gives an example reason");
  const banned = /\b(?:token|tokens|limit|limits|context|model|models|tool|tools|sandbox|aegis|mcp|api|llm|reasoning|budget|zaru\.mode)\b/i;
  assert.ok(!banned.test(example![1]), `the example reason carries no jargon: ${example![1]}`);
  const sentences = example![1].split(/(?<=[.!?])\s+/).filter((s) => s.length > 0);
  assert.ok(sentences.length >= 1 && sentences.length <= 2, "the example reason is one or two sentences");
});

test("W41: the chat prompt no longer says the model cannot call tools, and names no surface's controls", () => {
  const own = chatOwnText();
  assert.ok(!own.includes("cannot execute tasks or call tools"), "the retired contradiction is gone");
  // Zaru ADR-0027 D2: the served prompt is universal; a card or a button is one surface's.
  assert.ok(!/\b(?:card|button|click|tap)\b/i.test(own), "no surface-specific control is named");
});

test("W41: after calling zaru.mode the model waits for the person", () => {
  const section = modeDecisionSection();
  assert.ok(/After you call zaru\.mode, stop/.test(section), "the model stops after the call");
});

// Every other prompt is byte for byte what it was at aegis-mcp-tools 688b587,
// when the chat prompt's mode decision was written. A change to one of these
// is a change to that mode's own record, not to W41. The two agentic pins were
// re-measured for Zaru ADR-0026's Update of 2026-10-06 (D3a), that mode's own
// record; the two agentic pins and the execute pin were re-measured again for
// Zaru ADR-0020's Update of 2026-10-06 (K5, K5a, K5b: Step 5, files the run
// made); the operator pin was re-measured for Zaru ADR-0050's Update of
// 2026-10-06 (V2: a deployed agent is fixed in place with aegis.agent.update);
// the agentic, workflow and execute pins (and their chat-uploads forms) were
// re-measured for AEGIS ADR-131 U33 (the person's stop: aegis.goal.cancel);
// the agentic, workflow, execute and operator pins (and their chat-uploads
// forms) were re-measured for Zaru ADR-0028 W51a (a changed input to a
// computation is run again; the companion chooses the agent or workflow);
// the agentic and workflow pins (and their chat-uploads forms) were
// re-measured for AEGIS ADR-139 N13 (one sentence teaching aegis.schedule.create);
// every other pin stands as it was.
const UNCHANGED_PROMPTS: Array<[string, () => ReturnType<typeof getZaruInit>, number, string]> = [
  ["agentic", () => getZaruInit("agentic"), 12810, "d055affeeff4bfe963672efecea666565f8d689d2e92ea17ba375a2cd5faf83e"],
  ["agentic+chat-uploads", () => getZaruInit("agentic", new Set(["chat-uploads"])), 16620, "59432b9aff1fcdc88b9e4d55299b925a4b1aefe1f89dd94472064300739ecf55"],
  ["workflow", () => getZaruInit("workflow"), 9306, "ae527cca5ced81adc8e88f2d202d6244605346e4ed6891e2e91574d8eecc1759"],
  ["workflow+chat-uploads", () => getZaruInit("workflow", new Set(["chat-uploads"])), 13116, "7a14c1f4d03bcecb7f69e8c50a90f26a00f514992f259c54f36bd88342f7f07f"],
  ["execute", () => getZaruInit("execute"), 10980, "89402024133823cce1ff41918984e9908f0f0b2eb754bda5161a24c32750fe4e"],
  ["live", () => getZaruInit("live", new Set(["live"]), "browser"), 7910, "217f83602b4e3f058945fc6e2e5baada5dd18651c76e3ac269d95ca92cf355a5"],
  ["vibecode", () => getZaruInit("vibecode", new Set(["vibecode"]), "browser"), 11340, "149229a0ab6350a11ac8b68ef858247dedd316882a69ebc2a49711b49456bd83"],
  ["operator", () => getZaruInit("operator", new Set(), undefined, { isOperator: true, tier: "operator" }), 10071, "42a08a9aa78f13b407254ce9f672e60358e62142ea604d6cc53072ff83b8c216"],
];

test("W41: every other mode's prompt is unchanged byte for byte", () => {
  for (const [name, init, length, sha256] of UNCHANGED_PROMPTS) {
    const prompt = init()!.system_prompt;
    assert.equal(prompt.length, length, `'${name}' prompt length`);
    assert.equal(createHash("sha256").update(prompt).digest("hex"), sha256, `'${name}' prompt bytes`);
  }
});

// ---------------------------------------------------------------------------
// Operator mode: a deployed agent is fixed in place (Zaru ADR-0050's Update of
// 2026-10-06, V1 to V4). Jeshua: "We should add agent update to operator
// tools". The escalated connection already carried the update tools; the
// operator mode's own list and prompt did not, so a model in that mode had no
// way to fix a deployed agent's manifest but to create another.
// ---------------------------------------------------------------------------

const operatorInit = () => getZaruInit("operator", new Set(), undefined, { isOperator: true, tier: "operator" })!;

test("ADR-0050 V1: the operator mode lists the update tools and the export the update needs", () => {
  const tools = operatorInit().available_tools;
  const missing = ["aegis.agent.update", "aegis.workflow.update", "aegis.workflow.signal", "aegis.agent.export"].filter(
    (tool) => !tools.includes(tool),
  );
  assert.deepEqual(missing, [], `the operator tool list lacks ${missing.join(", ")}`);
});

test("ADR-0050 V2: the operator prompt fixes a deployed agent's manifest with aegis.agent.update", () => {
  const prompt = operatorInit().system_prompt;
  assert.ok(
    prompt.includes("then call aegis.agent.update with { \"manifest_yaml\": \"<the changed manifest>\" }") &&
      prompt.includes("raise its metadata.version"),
    "the operator prompt names aegis.agent.update with manifest_yaml as the way to fix a deployed agent's manifest",
  );
  assert.ok(!/\bforce\b/.test(prompt), "the operator prompt never names force");
});

test("ADR-0050 V4: every aegis.* tool the operator prompt names is in the operator tool list", () => {
  const init = operatorInit();
  const named = [...new Set(init.system_prompt.match(/aegis\.[a-z_]+(?:\.[a-z_]+)+/g) ?? [])];
  assert.ok(named.length > 0, "the operator prompt names aegis.* tools");
  const unlisted = named.filter((tool) => !init.available_tools.includes(tool));
  assert.deepEqual(unlisted, [], `the operator prompt names tools its list lacks: ${unlisted.join(", ")}`);
});

// ---------------------------------------------------------------------------
// Agentic mode: every request for a result is dispatched (Zaru ADR-0026's
// Update of 2026-10-06, D3a). Asked "43 inches in centimeters" in Agentic
// mode, the model answered it itself with no agent: the prompt's rules fired
// on a list of "do" verbs (create, write, generate, analyze, process...) and
// no line covered a question the model could answer from what it knows. The
// trigger is now the request for a result, however simple, with no verb list;
// only talk about the work in hand is answered directly, and conversation
// alone is offered Chat. These tests pin the text; whether the model obeys
// it is proved on the live page, not here.
// ---------------------------------------------------------------------------

/** Agentic mode's own text: after the shared personality, before the Zaru promise. */
function agenticOwnText(caps?: Set<string>): string {
  const agentic = getZaruInit("agentic", caps)!.system_prompt;
  const personality = sharedPersonality();
  assert.ok(agentic.startsWith(personality), "the agentic prompt opens with the shared personality");
  const end = agentic.indexOf("\n# THE ZARU PROMISE");
  assert.ok(end > personality.length, "the agentic prompt closes with the Zaru promise");
  return agentic.slice(personality.length, end);
}

/** Verbs a request might be phrased with. Two of them in one comma-separated run are a verb list. */
const REQUEST_VERBS =
  "(?:create|write|generate|analy[sz]e|process|compute|calculate|convert|look up|produce|research|automate|send|summari[sz]e|translate|search|find|build|make)";
const VERB_LIST = new RegExp(`\\b${REQUEST_VERBS}\\b[^,.\\n]{0,24},\\s*(?:(?:and|or)\\s+)?\\b${REQUEST_VERBS}\\b`, "i");

test("ADR-0026 D3a: the Agentic text says every request for a result is dispatched, however simple, and names no verb list", () => {
  for (const caps of [undefined, new Set(["chat-uploads"])]) {
    const own = agenticOwnText(caps);
    const failures: string[] = [];
    if (!/every request for a result/i.test(own)) failures.push("it does not say every request for a result is dispatched");
    if (!/however simple/i.test(own)) failures.push("it does not say however simple");
    const list = own.match(VERB_LIST);
    if (list) failures.push(`it names a verb list: "${list[0]}"`);
    if (/asks you to DO\b/.test(own)) failures.push('the rules still fire on "asks you to DO"');
    assert.deepEqual(failures, [], `Agentic text (${caps ? "chat-uploads" : "base"}): ${failures.join("; ")}`);
  }
});

test("ADR-0026 D3a: the mandatory sequence covers every request for a result and starts with aegis.agent.list", () => {
  const own = agenticOwnText();
  const heading = own.indexOf("## MANDATORY SEQUENCE");
  assert.ok(heading >= 0, "the Agentic text holds the mandatory sequence");
  const step1 = own.indexOf("**Step 1", heading);
  const intro = own.slice(heading, step1);
  assert.ok(/every request for a result/i.test(intro), "the sequence is for every request for a result");
  assert.ok(/aegis\.agent\.list FIRST/.test(own.slice(step1, own.indexOf("**Step 2", step1))), "Step 1 calls aegis.agent.list first");
});

test("ADR-0026 D3a: only talk about the work in hand is answered directly; conversation alone is offered Chat through zaru.mode", () => {
  const own = agenticOwnText();
  assert.ok(/answer directly[^.]*work in hand|work in hand[^.]*answer(?:ed)? directly/i.test(own), "talk about the work in hand is answered directly");
  const chatLine = own.split("\n").find((line) => line.startsWith("- chat:"));
  assert.ok(chatLine, "rule 6 names the chat mode");
  assert.ok(/conversation alone/i.test(chatLine!), `the chat line is for conversation alone: ${chatLine}`);
  assert.ok(!/pure conversation with no execution needed/.test(own), "the old chat line is gone");
});

// ---------------------------------------------------------------------------
// Files the run made (Zaru ADR-0020's Update of 2026-10-06, K5, K5a, K5b).
// The result card of a completed aegis.task.wait or aegis.agent.wait lists
// the execution's produced_files as download cards (zaru-client 7edc066), so
// Step 5 no longer tells the model to fetch a file the person already has.
// aegis.execute.wait carries no produced_files until AEGIS ADR-005 I9 lands,
// so the Execute prompt calls a file unmade only when the key is present.
// These tests pin the text; whether the model obeys it is proved on the live
// page, not here.
// ---------------------------------------------------------------------------

/** K5's first sentence, verbatim from the record. */
const K5_FIRST_SENTENCE =
  "If the wait result's `produced_files` lists a file, it already reaches the user as a download card on the result: do not call `aegis.execution.file` for it.";

/** K5a's fourth sentence, verbatim from the record: the Execute prompt only. */
const K5A_FOURTH_SENTENCE =
  "If the wait result carries no `produced_files`, do not say whether a file named in `last_output` was made.";

test("ADR-0020 K5, K5a, K5b: Step 5 says a listed file already reaches the user, and no prompt still fetches every named file", () => {
  const failures: string[] = [];
  const changed: Array<[string, string]> = [
    ["agentic", getZaruInit("agentic")!.system_prompt],
    ["agentic+chat-uploads", getZaruInit("agentic", new Set(["chat-uploads"]))!.system_prompt],
    ["execute", getZaruInit("execute")!.system_prompt],
  ];
  for (const [name, prompt] of changed) {
    if (!prompt.includes(K5_FIRST_SENTENCE)) failures.push(`'${name}' does not hold K5's first sentence`);
    if (prompt.includes("IMMEDIATELY call")) failures.push(`'${name}' still says "IMMEDIATELY call"`);
    if (prompt.includes("Retrieve files if mentioned")) failures.push(`'${name}' still says "Retrieve files if mentioned"`);
    if (!prompt.includes("**Step 5 — Files the run made.**")) failures.push(`'${name}' has no "Step 5 — Files the run made." heading`);
  }
  const execute = changed[2][1];
  if (!execute.includes(K5A_FOURTH_SENTENCE)) failures.push("'execute' does not hold K5a's fourth sentence");
  for (const [name, prompt] of changed.slice(0, 2)) {
    if (prompt.includes(K5A_FOURTH_SENTENCE)) failures.push(`'${name}' holds K5a's fourth sentence, which is the Execute prompt's alone`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

// ---------------------------------------------------------------------------
// A conversation's chosen contexts (AEGIS ADR-132 S7, S8; Zaru ADR-0055 D19b,
// D20f; Zaru ADR-0058 D3, D3a; Zaru ADR-0048 3f): with a binding chosen, every
// mode's prompt ends with the teaching under one heading, one sentence per
// chosen server in a fixed order (nuclear-notes, github, imap, caldav, then
// any other server by name), and the several-of-one-kind sentence last when a
// server whose tools take '_context' names two or more bindings (a mail tool
// names its mailbox in 'mailbox' and a calendar tool its account in 'account',
// so two mailboxes or two calendar accounts never add it); without one, every
// prompt is byte for byte as pinned above.
// ---------------------------------------------------------------------------

const CONTEXT_HEADING = "# THE PERSON'S CHOSEN CONTEXT";

/** The teaching as it stood with one context type, before ADR-0058 D3. */
const NUCLEAR_NOTES_TEACHING =
  "\n\n# THE PERSON'S CHOSEN CONTEXT\n\nThe person has chosen a context above the chat input, and its tools are listed to you under its name (for Nuclear Notes, the tools whose names begin with nuclear-notes.). They reach what the person keeps there, as the person, and nothing else. When a message touches something the person may have written down, search and read it with these tools within this turn before you answer, and name what you read so the person can open it. Read and change only what the message asks for. If a call is refused, tell the person in one sentence and answer without it.";

const NUCLEAR_NOTES_SENTENCE = NUCLEAR_NOTES_TEACHING.slice(`\n\n${CONTEXT_HEADING}\n\n`.length);

const GITHUB_SENTENCE =
  "The tools whose names begin with github. reach the person's GitHub repositories, issues and pull requests as their token allows. Read and change only what the message asks for. A merge or a change to a file on GitHub waits for the person's approval; say so when you make one. If a call is refused, tell the person in one sentence and answer without it.";

const MAILBOX_SENTENCE =
  "The tools whose names begin with mail. reach the person's mailbox they chose above the chat input: list, read and flag their threads, and nothing else until they ask. A call names which mailbox in 'mailbox' when several are chosen; with one chosen it is set for you. Read only what the message asks for; never send, delete or move mail unless the message asks, and say so when you do. If a call is refused, tell the person in one sentence and answer without it.";

const genericSentence = (server: string) =>
  `The tools whose names begin with ${server}. reach the person's ${server} connection as their credential allows. Read and change only what the message asks for. If a call is refused, tell the person in one sentence and answer without it.`;

const SEVERAL_OF_ONE_KIND =
  "When you have several contexts of one kind, each of their tools takes '_context': name the one the message means, and say which you used.";

const BINDING_A = "3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c";
const BINDING_B = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const BINDING_C = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const CONTEXT_MODES = [
  ["chat", new Set<string>(), undefined],
  ["agentic", new Set(["chat-uploads"]), undefined],
  ["workflow", new Set<string>(), undefined],
  ["execute", new Set<string>(), undefined],
  ["live", new Set(["live"]), "browser"],
  ["vibecode", new Set(["vibecode"]), "browser"],
  ["operator", new Set<string>(), undefined],
] as const;

const CONTEXT_OPERATOR = { isOperator: true, tier: "operator" };

/** What each mode's prompt gains from `contexts`, or a complaint when its own prompt changed. */
type Contexts = Record<string, string | string[] | null>;

function teachingsFor(contexts: Contexts): Array<[string, string]> {
  return CONTEXT_MODES.map(([mode, caps, runtime]) => {
    const without = getZaruInit(mode, caps, runtime, CONTEXT_OPERATOR)!.system_prompt;
    const withContexts = getZaruInit(mode, caps, runtime, CONTEXT_OPERATOR, contexts)!.system_prompt;
    if (!withContexts.startsWith(without)) return [mode, `the mode's own prompt changed`];
    return [mode, withContexts.slice(without.length)];
  });
}

/** The teaching built from its parts, as D3 and D3a order them. */
function taught(...sentences: string[]): string {
  return `\n\n${CONTEXT_HEADING}` + sentences.map((s) => `\n\n${s}`).join("");
}

test("D3: Nuclear Notes alone is taught exactly as before, once, at the end of every mode's prompt", () => {
  const complaints: string[] = [];
  for (const contexts of [{ "nuclear-notes": [BINDING_A] }, { "nuclear-notes": BINDING_A, github: null }] as Contexts[]) {
    for (const [mode, gained] of teachingsFor(contexts)) {
      if (gained !== NUCLEAR_NOTES_TEACHING) {
        complaints.push(`${mode} ${JSON.stringify(contexts)}: taught ${JSON.stringify(gained.slice(0, 120))}`);
      }
    }
  }
  assert.deepEqual(complaints, []);
});

test("D3: a chosen github binding appends GitHub's sentence once in every mode; none, null or Nuclear Notes alone does not", () => {
  const complaints: string[] = [];
  for (const [mode, gained] of teachingsFor({ github: [BINDING_A] })) {
    if (gained !== taught(GITHUB_SENTENCE)) complaints.push(`${mode}: GitHub not taught alone, got ${JSON.stringify(gained.slice(0, 160))}`);
  }
  for (const contexts of [{}, { github: null }, { "nuclear-notes": [BINDING_A] }] as Contexts[]) {
    for (const [mode, gained] of teachingsFor(contexts)) {
      if (gained.includes(GITHUB_SENTENCE)) complaints.push(`${mode} ${JSON.stringify(contexts)}: GitHub taught`);
    }
  }
  assert.deepEqual(complaints, []);
});

test("D3: both types chosen teach both sentences under one heading, Nuclear Notes first", () => {
  const complaints: string[] = [];
  // The header names GitHub first; the teaching's order is the table's.
  for (const [mode, gained] of teachingsFor({ github: [BINDING_B], "nuclear-notes": [BINDING_A] })) {
    if (gained !== taught(NUCLEAR_NOTES_SENTENCE, GITHUB_SENTENCE)) {
      complaints.push(`${mode}: both types not taught in order, got ${JSON.stringify(gained.slice(0, 160))}`);
    }
  }
  assert.deepEqual(complaints, []);
});

test("D3a: a server with no sentence of its own takes the generic sentence, never Nuclear Notes' paragraph, after the table's servers by name", () => {
  const complaints: string[] = [];
  for (const [mode, gained] of teachingsFor({ zeta: [BINDING_A] })) {
    if (gained !== taught(genericSentence("zeta"))) {
      complaints.push(`${mode}: zeta not taught the generic sentence, got ${JSON.stringify(gained.slice(0, 160))}`);
    }
  }
  for (const [mode, gained] of teachingsFor({ imap: [BINDING_A] })) {
    if (gained.includes(genericSentence("imap"))) complaints.push(`${mode}: imap taught the generic sentence`);
  }
  for (const [mode, gained] of teachingsFor({
    zeta: BINDING_C,
    imap: [BINDING_B],
    github: [BINDING_A],
    "nuclear-notes": BINDING_A,
  })) {
    const expected = taught(NUCLEAR_NOTES_SENTENCE, GITHUB_SENTENCE, MAILBOX_SENTENCE, genericSentence("zeta"));
    if (gained !== expected) complaints.push(`${mode}: four servers not taught in the fixed order, got ${JSON.stringify(gained.slice(-200))}`);
  }
  assert.deepEqual(complaints, []);
});

test("3f: a chosen imap binding appends the mailbox sentence once in every mode; none, null or another server alone does not", () => {
  const complaints: string[] = [];
  for (const contexts of [{ imap: [BINDING_A] }, { imap: BINDING_A, github: null }] as Contexts[]) {
    for (const [mode, gained] of teachingsFor(contexts)) {
      if (gained !== taught(MAILBOX_SENTENCE)) {
        complaints.push(`${mode} ${JSON.stringify(contexts)}: the mailbox sentence not taught alone, got ${JSON.stringify(gained.slice(0, 160))}`);
      }
    }
  }
  for (const contexts of [{}, { imap: null }, { "nuclear-notes": [BINDING_A] }, { github: [BINDING_A] }] as Contexts[]) {
    for (const [mode, gained] of teachingsFor(contexts)) {
      if (gained.includes(MAILBOX_SENTENCE)) complaints.push(`${mode} ${JSON.stringify(contexts)}: the mailbox sentence taught`);
    }
  }
  assert.deepEqual(complaints, []);
});

test("3f: two chosen mailboxes teach the mailbox sentence without the '_context' sentence", () => {
  const complaints: string[] = [];
  for (const contexts of [{ imap: [BINDING_A, BINDING_B] }, { imap: [BINDING_A, BINDING_B], github: [BINDING_C] }] as Contexts[]) {
    for (const [mode, gained] of teachingsFor(contexts)) {
      if (gained.includes(SEVERAL_OF_ONE_KIND)) complaints.push(`${mode} ${JSON.stringify(contexts)}: two mailboxes taught '_context'`);
      if (!gained.includes(MAILBOX_SENTENCE)) complaints.push(`${mode} ${JSON.stringify(contexts)}: the mailbox sentence not taught`);
    }
  }
  assert.deepEqual(complaints, []);
});

test("3f: a mailbox beside two Nuclear Notes bindings teaches the '_context' sentence last", () => {
  const complaints: string[] = [];
  for (const [mode, gained] of teachingsFor({ imap: [BINDING_C], "nuclear-notes": [BINDING_A, BINDING_B] })) {
    if (gained !== taught(NUCLEAR_NOTES_SENTENCE, MAILBOX_SENTENCE, SEVERAL_OF_ONE_KIND)) {
      complaints.push(`${mode}: the mailbox and '_context' sentences not taught in order, got ${JSON.stringify(gained.slice(-200))}`);
    }
  }
  assert.deepEqual(complaints, []);
});

test("D20f: two bindings of one type append the '_context' sentence last; one binding each does not", () => {
  const complaints: string[] = [];
  for (const [mode, gained] of teachingsFor({ "nuclear-notes": [BINDING_A, BINDING_B], github: [BINDING_C] })) {
    if (gained !== taught(NUCLEAR_NOTES_SENTENCE, GITHUB_SENTENCE, SEVERAL_OF_ONE_KIND)) {
      complaints.push(`${mode}: the several-of-one-kind sentence is not last, got ${JSON.stringify(gained.slice(-200))}`);
    }
  }
  for (const [mode, gained] of teachingsFor({ "nuclear-notes": [BINDING_A], github: BINDING_B })) {
    if (gained.includes(SEVERAL_OF_ONE_KIND)) complaints.push(`${mode}: one binding each taught '_context'`);
  }
  assert.deepEqual(complaints, []);
});

/** The arguments of the eight pinned prompts above, by name. */
const PINNED_ARGUMENTS: Array<[string, string, Set<string>, string | undefined, typeof CONTEXT_OPERATOR | undefined]> = [
  ["agentic", "agentic", new Set(), undefined, undefined],
  ["agentic+chat-uploads", "agentic", new Set(["chat-uploads"]), undefined, undefined],
  ["workflow", "workflow", new Set(), undefined, undefined],
  ["workflow+chat-uploads", "workflow", new Set(["chat-uploads"]), undefined, undefined],
  ["execute", "execute", new Set(), undefined, undefined],
  ["live", "live", new Set(["live"]), "browser", undefined],
  ["vibecode", "vibecode", new Set(["vibecode"]), "browser", undefined],
  ["operator", "operator", new Set(), undefined, CONTEXT_OPERATOR],
];

test("D3: with no context chosen ({}, every server null) every pinned prompt is unchanged", () => {
  const complaints: string[] = [];
  for (const contexts of [{}, { "nuclear-notes": null, github: null, imap: null, caldav: null }] as Contexts[]) {
    for (const [name, mode, caps, runtime, user] of PINNED_ARGUMENTS) {
      const [, , length, sha256] = UNCHANGED_PROMPTS.find(([pinned]) => pinned === name)!;
      const prompt = getZaruInit(mode, caps, runtime, user, contexts)!.system_prompt;
      if (prompt.length !== length || createHash("sha256").update(prompt).digest("hex") !== sha256) {
        complaints.push(`'${name}' with ${JSON.stringify(contexts)}: the pinned prompt changed (length ${prompt.length})`);
      }
    }
    for (const [mode, gained] of teachingsFor(contexts)) {
      if (gained !== "") complaints.push(`${mode} with ${JSON.stringify(contexts)}: taught`);
    }
  }
  assert.deepEqual(complaints, []);
});

// AEGIS ADR-138 K12 and K13: a chosen calendar account (the service `caldav`)
// has its own sentence, after the mailbox's, in place of the generic one; a
// calendar tool names its account in 'account', so two calendar accounts never
// add the '_context' sentence; the sentence names no decision record.

const CALENDAR_SENTENCE =
  "The tools whose names begin with calendar. reach the calendars the person chose above the chat input: list their calendars, list events in a window, and read one event. Creating, changing, deleting or answering an event waits for the person's approval; do it only when the message asks, and say so when you do. A call names which account in 'account' when several are chosen; with one chosen it is set for you. If a call is refused, tell the person in one sentence and answer without it.";

test("K12: a chosen caldav binding appends the calendar sentence once in every mode, never the generic one; none, null or another server alone does not", () => {
  const complaints: string[] = [];
  for (const contexts of [{ caldav: [BINDING_A] }, { caldav: BINDING_A, imap: null }] as Contexts[]) {
    for (const [mode, gained] of teachingsFor(contexts)) {
      if (gained !== taught(CALENDAR_SENTENCE)) {
        complaints.push(`${mode} ${JSON.stringify(contexts)}: the calendar sentence not taught alone, got ${JSON.stringify(gained.slice(0, 160))}`);
      }
      if (gained.includes(genericSentence("caldav"))) complaints.push(`${mode} ${JSON.stringify(contexts)}: caldav taught the generic sentence`);
    }
  }
  for (const contexts of [{}, { caldav: null }, { "nuclear-notes": [BINDING_A] }, { github: [BINDING_A] }, { imap: [BINDING_A] }] as Contexts[]) {
    for (const [mode, gained] of teachingsFor(contexts)) {
      if (gained.includes(CALENDAR_SENTENCE)) complaints.push(`${mode} ${JSON.stringify(contexts)}: the calendar sentence taught`);
    }
  }
  assert.deepEqual(complaints, []);
});

test("K12: the calendar sentence follows the mailbox's in the fixed order, with Nuclear Notes', GitHub's and the mailbox's sentences byte for byte", () => {
  const complaints: string[] = [];
  for (const [mode, gained] of teachingsFor({
    zeta: BINDING_C,
    caldav: [BINDING_C],
    imap: [BINDING_B],
    github: [BINDING_A],
    "nuclear-notes": BINDING_A,
  })) {
    const expected = taught(NUCLEAR_NOTES_SENTENCE, GITHUB_SENTENCE, MAILBOX_SENTENCE, CALENDAR_SENTENCE, genericSentence("zeta"));
    if (gained !== expected) complaints.push(`${mode}: five servers not taught in the fixed order, got ${JSON.stringify(gained.slice(-200))}`);
  }
  for (const [mode, gained] of teachingsFor({ caldav: [BINDING_B], imap: [BINDING_A] })) {
    if (gained !== taught(MAILBOX_SENTENCE, CALENDAR_SENTENCE)) {
      complaints.push(`${mode}: the mailbox's and the calendar sentences not taught in order, got ${JSON.stringify(gained.slice(-200))}`);
    }
  }
  assert.deepEqual(complaints, []);
});

test("K12: two chosen calendar accounts teach the calendar sentence without the '_context' sentence; beside two Nuclear Notes bindings it comes last", () => {
  const complaints: string[] = [];
  for (const contexts of [{ caldav: [BINDING_A, BINDING_B] }, { caldav: [BINDING_A, BINDING_B], imap: [BINDING_C] }] as Contexts[]) {
    for (const [mode, gained] of teachingsFor(contexts)) {
      if (gained.includes(SEVERAL_OF_ONE_KIND)) complaints.push(`${mode} ${JSON.stringify(contexts)}: two calendar accounts taught '_context'`);
      if (!gained.includes(CALENDAR_SENTENCE)) complaints.push(`${mode} ${JSON.stringify(contexts)}: the calendar sentence not taught`);
    }
  }
  for (const [mode, gained] of teachingsFor({ caldav: [BINDING_C], "nuclear-notes": [BINDING_A, BINDING_B] })) {
    if (gained !== taught(NUCLEAR_NOTES_SENTENCE, CALENDAR_SENTENCE, SEVERAL_OF_ONE_KIND)) {
      complaints.push(`${mode}: the calendar and '_context' sentences not taught in order, got ${JSON.stringify(gained.slice(-200))}`);
    }
  }
  assert.deepEqual(complaints, []);
});

test("K12: with a calendar account chosen, each of the eight pinned prompts is unchanged and only gains the calendar teaching", () => {
  const complaints: string[] = [];
  for (const [name, mode, caps, runtime, user] of PINNED_ARGUMENTS) {
    const [, , length, sha256] = UNCHANGED_PROMPTS.find(([pinned]) => pinned === name)!;
    const prompt = getZaruInit(mode, caps, runtime, user, { caldav: [BINDING_A] })!.system_prompt;
    const own = prompt.slice(0, length);
    if (createHash("sha256").update(own).digest("hex") !== sha256) {
      complaints.push(`'${name}': the pinned prompt changed before the teaching`);
    }
    if (prompt.slice(length) !== taught(CALENDAR_SENTENCE)) {
      complaints.push(`'${name}': gained ${JSON.stringify(prompt.slice(length, length + 160))}, not the calendar teaching`);
    }
  }
  assert.deepEqual(complaints, []);
});

test("K13: the calendar teaching, as taught, names no decision record", () => {
  // The facing-text test's pattern (test/facing-text-no-record-refs.test.ts).
  const RECORD_REFERENCE = /ADR-[0-9]|CD-[0-9]|ADR [0-9]|[Dd]ecision record|security audit 0|audit 0[0-9][0-9]|§[0-9]/;
  const complaints: string[] = [];
  for (const [mode, gained] of teachingsFor({ caldav: [BINDING_A, BINDING_B] })) {
    if (!gained.includes(CALENDAR_SENTENCE)) complaints.push(`${mode}: the calendar sentence not taught`);
    for (const line of gained.split("\n")) {
      if (RECORD_REFERENCE.test(line)) complaints.push(`${mode}: a taught line names a decision record: ${JSON.stringify(line)}`);
    }
  }
  assert.deepEqual(complaints, []);
});

test("D19b: chat mode sends the person's own accounts to Agentic only beyond the chosen context", () => {
  const chat = getZaruInit("chat")!.system_prompt;
  assert.ok(
    chat.includes(
      "anything in the user's own accounts and systems other than the chosen context\n",
    ),
    "the chat prompt's routing line names the chosen context",
  );
});

// ---------------------------------------------------------------------------
// A computation is run, never written in the companion's own text, and the
// companion, not the person, chooses which agent or workflow serves a request
// (Zaru ADR-0028 W51a). Asked mid conversation to recalculate an itinerary an
// agent had solved, from a changed input, nothing in the prompts said a
// changed input is a new request for a result: Agentic's rule 5 let it pass as
// talk about "what a result means", Step 3 sent the person's message alone,
// and Step 1 could find an existing agent only by listing. These tests pin the
// text; whether the model obeys it is proved on the live page, not here.
// ---------------------------------------------------------------------------

/** Each mode's changed-input sentence, verbatim from the survey's P1, P5 to P8. */
const CHANGED_INPUT_SENTENCES: Array<[string, () => ReturnType<typeof getZaruInit>, string]> = [
  [
    "agentic",
    () => getZaruInit("agentic"),
    "A change to an input of a computation already run in this conversation (a new time, a different number, one more stop or one fewer) is a new request for a result: it is run again with the change, and you never work out the new result in your own text, however small the change looks.",
  ],
  [
    "agentic+chat-uploads",
    () => getZaruInit("agentic", new Set(["chat-uploads"])),
    "A change to an input of a computation already run in this conversation (a new time, a different number, one more stop or one fewer) is a new request for a result: it is run again with the change, and you never work out the new result in your own text, however small the change looks.",
  ],
  [
    "execute",
    () => getZaruInit("execute"),
    "A change to an input of something already computed in this conversation is a new intent: call aegis.execute.intent with the whole request again, the change made in it, and never work out the new result yourself.",
  ],
  [
    "workflow",
    () => getZaruInit("workflow"),
    "A change to an input of a run already made in this conversation is a new run: dispatch it with the change made in its input, and never work out the new result yourself.",
  ],
  [
    "operator",
    () => getZaruInit("operator", new Set(), undefined, { isOperator: true, tier: "operator" }),
    "A change to an input of a run already made in this conversation is a new run: dispatch it with the change made in its input, and never work out the new result yourself.",
  ],
  [
    "chat",
    () => getZaruInit("chat"),
    "A change to an input of a request that needs Agentic mode still needs it, however small the change.",
  ],
];

for (const [name, init, sentence] of CHANGED_INPUT_SENTENCES) {
  test(`W51a: the ${name} prompt says a changed input to an earlier computation is dispatched again, never worked out in its own text`, () => {
    const prompt = init()!.system_prompt;
    assert.ok(prompt.includes(sentence), `the ${name} prompt lacks its changed-input sentence: "${sentence}"`);
    assert.equal(prompt.split(sentence).length, 2, `the ${name} prompt holds its changed-input sentence once`);
  });
}

test("W51a: Agentic's direct answers no longer cover working out what a result means; only a result already given is talked about", () => {
  const own = agenticOwnText();
  const failures: string[] = [];
  if (own.includes("what a result means,")) failures.push('rule 5 still answers "what a result means" directly');
  if (!own.includes("what a result already given means")) failures.push('rule 5 does not narrow it to "what a result already given means"');
  assert.deepEqual(failures, [], `Agentic rule 5: ${failures.join("; ")}`);
});

test("W51a: Agentic's Step 3 sends the earlier request with the change made in it, not the change alone", () => {
  const own = agenticOwnText();
  const step3 = own.indexOf("**Step 3");
  const step4 = own.indexOf("**Step 4", step3);
  assert.ok(step3 >= 0 && step4 > step3, "the Agentic text has Step 3 then Step 4");
  const sentence =
    "When the user's message changes an input of a computation already run, the full request is the earlier request with that change made in it: write it out whole, so the agent has every input and not the change alone.";
  assert.ok(own.slice(step3, step4).includes(sentence), `Step 3 lacks: "${sentence}"`);
});

test("W51a: the choice of agent is the companion's: never ask the user which agent, and the agent that ran before is one choice among those found", () => {
  for (const caps of [undefined, new Set(["chat-uploads"])]) {
    const own = agenticOwnText(caps);
    const failures: string[] = [];
    if (!own.includes("Which of your 100monkeys serves a request is your choice, never the user's."))
      failures.push("it does not say the choice is the companion's, never the user's");
    if (!/never ask the user which agent to use/.test(own)) failures.push("it does not say never ask the user which agent to use");
    if (!/the agent that ran it before is one choice among those you find, never one you must use/.test(own))
      failures.push("it does not say the agent that ran before is one choice among those found");
    if (!own.includes("you find the agent, the workflow or the new agent that serves it"))
      failures.push("it does not name an agent, a workflow or a new agent as what the companion finds");
    assert.deepEqual(failures, [], `Agentic text (${caps ? "chat-uploads" : "base"}): ${failures.join("; ")}`);
  }
});

test("W51a: Step 1 finds agents and workflows by search and runs a matching workflow with its run and wait tools", () => {
  const own = agenticOwnText();
  const step1 = own.indexOf("**Step 1");
  const step2 = own.indexOf("**Step 2", step1);
  const s1 = own.slice(step1, step2);
  const failures: string[] = [];
  for (const tool of ["aegis.agent.search", "aegis.workflow.search", "aegis.workflow.run", "aegis.workflow.wait"]) {
    if (!s1.includes(tool)) failures.push(`Step 1 does not name ${tool}`);
  }
  if (s1.indexOf("aegis.agent.list FIRST") < 0 || s1.indexOf("aegis.agent.list FIRST") > s1.indexOf("aegis.agent.search"))
    failures.push("Step 1 does not call aegis.agent.list first, before any search");
  if (!own.includes("Only after aegis.task.wait (or aegis.workflow.wait) returns:"))
    failures.push("Step 4 does not report after aegis.workflow.wait too");
  assert.deepEqual(failures, [], failures.join("; "));
});

test("W51a: every aegis.* tool the Agentic prompt names is in the Agentic tool list, and the list holds the search, run and wait tools", () => {
  // The base prompt only: the chat-uploads teaching names aegis.attachment.read,
  // which the dispatched agent calls inside its sandbox, not the companion.
  const failures: string[] = [];
  const init = getZaruInit("agentic")!;
  const named = [...new Set(init.system_prompt.match(/aegis\.[a-z_]+(?:\.[a-z_]+)+/g) ?? [])];
  const unlisted = named.filter((tool) => !init.available_tools.includes(tool));
  if (unlisted.length) failures.push(`the Agentic prompt names tools its list lacks: ${unlisted.join(", ")}`);
  const tools = init.available_tools;
  const missing = ["aegis.agent.search", "aegis.workflow.search", "aegis.workflow.run", "aegis.workflow.wait"].filter(
    (tool) => !tools.includes(tool),
  );
  if (missing.length) failures.push(`the Agentic tool list lacks ${missing.join(", ")}`);
  assert.deepEqual(failures, [], failures.join("; "));
});

/** A sentence that makes rerunning the same agent a rule rather than one choice. */
const SAME_AGENT_RULE =
  /\b(?:always|must|should|have to)\b[^.\n]{0,60}\b(?:re-?run|run again|reuse|use)\b[^.\n]{0,30}\bsame agent\b|\bsame agent\b[^.\n]{0,60}\b(?:always|must|every time)\b/i;

test("W51a: no mode's prompt makes rerunning the same agent a rule", () => {
  const hits: string[] = [];
  for (const [mode, init] of [
    ...ALL_MODES,
    ["agentic+chat-uploads", getZaruInit("agentic", new Set(["chat-uploads"]))] as [string, ReturnType<typeof getZaruInit>],
    ["workflow+chat-uploads", getZaruInit("workflow", new Set(["chat-uploads"]))] as [string, ReturnType<typeof getZaruInit>],
  ]) {
    const hit = init!.system_prompt.match(SAME_AGENT_RULE);
    if (hit) hits.push(`${mode}: "${hit[0]}"`);
  }
  assert.deepEqual(hits, [], `a prompt makes rerunning the same agent a rule: ${hits.join("; ")}`);
});

// ---------------------------------------------------------------------------
// AEGIS ADR-139 N13: a person can schedule an agent or a workflow from their
// MCP client. The aegis.schedule.* tools reach the client through the
// orchestrator's listing once the person's context admits them; the agentic
// and workflow teachings gain one sentence, verbatim from the record, where
// each names its starting tool, and no other mode's prompt holds it.
// ---------------------------------------------------------------------------

const SCHEDULE_SENTENCE =
  "To run an agent or a workflow later or again and again, make a schedule with aegis.schedule.create; it runs as the person, and anything it would send waits for their approval.";

test("N13: the agentic and workflow prompts hold the schedule sentence once, beside their starting tool; no other mode's prompt holds it", () => {
  const failures: string[] = [];
  const holders: Array<[string, Set<string>, string, string, string]> = [
    ["agentic", new Set(), "**Step 3", "**Step 4", "The execution is NOT done until aegis.task.wait returns. "],
    ["agentic", new Set(["chat-uploads"]), "**Step 3", "**Step 4", "The execution is NOT done until aegis.task.wait returns. "],
    ["workflow", new Set(), "**Step 5", "**Step 6", "Do NOT respond to the user until aegis.task.wait returns. "],
    ["workflow", new Set(["chat-uploads"]), "**Step 5", "**Step 6", "Do NOT respond to the user until aegis.task.wait returns. "],
  ];
  for (const [mode, caps, from, to, before] of holders) {
    const name = caps.size ? `${mode}+chat-uploads` : mode;
    const prompt = getZaruInit(mode, caps)!.system_prompt;
    const count = prompt.split(SCHEDULE_SENTENCE).length - 1;
    if (count !== 1) {
      failures.push(`the ${name} prompt holds the schedule sentence ${count} times, not once`);
      continue;
    }
    const start = prompt.indexOf(from);
    const end = prompt.indexOf(to, start);
    const at = prompt.indexOf(SCHEDULE_SENTENCE);
    if (!(start >= 0 && start < at && at < end)) failures.push(`the ${name} prompt's schedule sentence is not in its ${from.slice(2)}`);
    if (prompt.slice(at - before.length, at) !== before) failures.push(`the ${name} prompt's schedule sentence does not follow "${before.trim()}"`);
    if (prompt.slice(at + SCHEDULE_SENTENCE.length, at + SCHEDULE_SENTENCE.length + 2) !== "\n\n")
      failures.push(`the ${name} prompt's schedule sentence does not end its paragraph`);
  }
  for (const [mode, init] of ALL_MODES) {
    if (mode === "agentic" || mode === "workflow") continue;
    if (init!.system_prompt.includes("aegis.schedule.")) failures.push(`the ${mode} prompt names a schedule tool`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

const SCHEDULE_TOOLS = [
  "aegis.schedule.create",
  "aegis.schedule.list",
  "aegis.schedule.get",
  "aegis.schedule.update",
  "aegis.schedule.pause",
  "aegis.schedule.resume",
  "aegis.schedule.delete",
  "aegis.schedule.runs",
];

test("N13: the agentic and workflow tool lists hold the eight schedule tools after aegis.workflow.wait; no other mode's list holds one", () => {
  const failures: string[] = [];
  for (const [mode, init] of ALL_MODES) {
    const tools = init!.available_tools;
    if (mode === "agentic" || mode === "workflow") {
      const at = tools.indexOf("aegis.workflow.wait");
      const after = tools.slice(at + 1, at + 1 + SCHEDULE_TOOLS.length);
      if (at < 0 || JSON.stringify(after) !== JSON.stringify(SCHEDULE_TOOLS))
        failures.push(`the ${mode} list does not hold the eight schedule tools after aegis.workflow.wait, got ${JSON.stringify(after)}`);
    } else {
      const held = tools.filter((tool) => tool.startsWith("aegis.schedule."));
      if (held.length) failures.push(`the ${mode} list holds ${held.join(", ")}`);
    }
  }
  assert.deepEqual(failures, [], failures.join("; "));
});
