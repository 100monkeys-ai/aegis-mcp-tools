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
// every other pin stands as it was.
const UNCHANGED_PROMPTS: Array<[string, () => ReturnType<typeof getZaruInit>, number, string]> = [
  ["agentic", () => getZaruInit("agentic"), 11344, "f508986164aba954cd22f86f52620a0a6611e742b29af437d125b74db35f8a81"],
  ["agentic+chat-uploads", () => getZaruInit("agentic", new Set(["chat-uploads"])), 15154, "1dc48b5caf4f04803afc0fb90bc81a6b68e6056b2731aacd8ce53d2bb5fe7903"],
  ["workflow", () => getZaruInit("workflow"), 8961, "004c4e13d7459545e5b7383a65793674b16ff6bd71fee64e334b3e75881830ce"],
  ["workflow+chat-uploads", () => getZaruInit("workflow", new Set(["chat-uploads"])), 12771, "95dda9946813085fc322ab2a777d7bff90366c769b6070ecc80469be63878119"],
  ["execute", () => getZaruInit("execute"), 10768, "e33841b9d90b44106c324fa60522f6405c8fdd5a2962067610ed08cdb9b6941b"],
  ["live", () => getZaruInit("live", new Set(["live"]), "browser"), 7910, "217f83602b4e3f058945fc6e2e5baada5dd18651c76e3ac269d95ca92cf355a5"],
  ["vibecode", () => getZaruInit("vibecode", new Set(["vibecode"]), "browser"), 11340, "149229a0ab6350a11ac8b68ef858247dedd316882a69ebc2a49711b49456bd83"],
  ["operator", () => getZaruInit("operator", new Set(), undefined, { isOperator: true, tier: "operator" }), 9902, "e07c1f5f314a71f15932e86342fca8dfc5dc7b4b5e048d654f81a6e52f4f22b3"],
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
