import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { ZaruUser } from "../src/middleware/auth.js";
import { OrchestratorClient } from "../src/mcp/orchestrator-client.js";
import { createMcpServerForUser } from "../src/mcp/streamable-http.js";
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
    "zaru.schedule",
    "zaru.docs",
    "zaru.connection.needed", // connection-needs-server-C1 (Zaru ADR-0070 D3 (a))
    "zaru.memory.get",
    "zaru.memory.set",
    "zaru.conversations.list",
    "zaru.conversations.read",
    "zaru.conversations.search",
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
    "zaru.schedule",
    "zaru.docs",
    "zaru.connection.needed", // connection-needs-server-C1 (Zaru ADR-0070 D3 (a))
    "zaru.memory.get",
    "zaru.memory.set",
    "zaru.conversations.list",
    "zaru.conversations.read",
    "zaru.conversations.search",
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
/** Zaru ADR-0070 D3 (b)'s three sentences, appended to every mode's prompt: shared teaching, not the chat mode's own text. */
const CONNECTION_NEEDS_TEACHING = [
  "When a message needs the person's mail, calendar, GitHub, Nuclear Notes or another connection and no tool of it is listed to you, call zaru.connection.needed with that family, tell the person in one sentence what to connect or choose and that the card above takes them there, and end your turn. Ask nothing else.",
  "When a call is refused because something is not connected, not chosen or not in the chosen profile, tell the person in one sentence what is missing and that the card above takes them there, and end your turn.",
  "Never say a connection is or is not made unless a tool's answer says so.",
]
  .map((sentence) => `\n\n${sentence}`)
  .join("");

/** A served prompt without D3 (b)'s appended teaching (it appears once, after the mode's own text). */
const withoutConnectionNeeds = (prompt: string) => prompt.replace(CONNECTION_NEEDS_TEACHING, "");

function chatOwnText(): string {
  // connection-needs-server: D3 (b)'s teaching is appended to every mode and is not the chat mode's own text.
  const chat = withoutConnectionNeeds(getZaruInit("chat")!.system_prompt);
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
// the agentic and workflow pins (and their chat-uploads forms) were
// re-measured for AEGIS ADR-139 N17 (one sentence teaching zaru.schedule);
// every pin was re-measured for Zaru ADR-0059 C10 (the shared personality's
// section on the person's other conversations, 648 characters in each);
// the agentic and workflow pins (and their chat-uploads forms) were
// re-measured for AEGIS ADR-139 N20 (one sentence naming the proposal's
// target, 85 characters in each);
// the agentic and workflow pins (and their chat-uploads forms) were
// re-measured for AEGIS ADR-139 N24 (the sentence teaching aegis.schedule.create
// replaced by one proposing the schedule from the run, 26 characters fewer in
// each);
// the agentic and execute pins (and the agentic chat-uploads form) were
// re-measured for AEGIS ADR-143 I2 and T8 (one line of TOOL KNOWLEDGE teaching
// aegis.image.generate, 628 characters in each);
// the agentic and execute pins (and the agentic chat-uploads form) were
// re-measured for AEGIS ADR-143 T8's second leg (the image exception before
// the mandatory sequence, and that TOOL KNOWLEDGE line shortened; 442
// characters more in each);
// the agentic pin and its chat-uploads form were re-measured for AEGIS ADR-143
// S5 (one line of TOOL KNOWLEDGE teaching transcribe-audio, 350 characters
// more in each);
// the agentic pin and its chat-uploads form were re-measured for the three
// TOOL KNOWLEDGE lines teaching aegis.workflow.signal, aegis.workflow.create
// and aegis.workflow.update (1389 characters more in each);
// those three lines moved to the workflow prompt on Jeshua's word of
// 2026-10-12 ("There's a workflow mode, aside from agentic and chat"): the
// agentic pin and its chat-uploads form are their values at 3e3ff265 again,
// and the workflow pin and its chat-uploads form were re-measured for the
// workflow prompt's new TOOL KNOWLEDGE block holding them (1409 characters more
// in each);
// the agentic and workflow pins (and their chat-uploads forms) were
// re-measured for the gate-conduct rules (the GC tests at the end of this
// file): the workflow prompt's TOOL KNOWLEDGE gains the aegis.workflow.run and
// aegis.workflow.wait lines and its aegis.workflow.signal line the gate rule
// (1775 characters more in each); the agentic prompt's gains the same run line
// and its own wait line (1250 characters more in each);
// the agentic and workflow pins (and their chat-uploads forms) were
// re-measured for the gate-fidelity rules (the GF tests at the end of this
// file): the workflow prompt's run line gains the inputs sentences, its wait
// line the fidelity sentences, its signal line the run's own id and the read
// after the signal, and its TOOL KNOWLEDGE a last line for aegis.workflow.logs
// (1559 characters more in each); the agentic prompt's run line gains the
// inputs sentences and its wait line the fidelity sentences (901 characters
// more in each);
// the agentic and workflow pins (and their chat-uploads forms) were
// re-measured for the signal's removal (the SR tests at the end of this file):
// the workflow prompt loses its aegis.workflow.signal line, its wait line
// names the person's own control and asks for no yes or no in the chat, its
// logs line reads the state after the person says they answered, and its run
// line says the gate is the person's control (664 characters fewer in each);
// the agentic prompt's run line gains the same sentence and its wait line the
// person's control and the read after their answer (471 characters more in
// each);
// the agentic and workflow pins (and their chat-uploads forms) were
// re-measured for the gate card (GK1 at the end of this file): each wait
// line names the card under the run in this conversation, Approvals and the
// run's execution page in place of the execution page on the AEGIS dashboard,
// asks for no answer in the chat and says no gate answered unless the mode's
// own run-reading tools answer so (134 characters more in each workflow
// prompt, 111 in each agentic prompt);
// the agentic and workflow pins (and their chat-uploads forms) were
// re-measured for run-then-yield (RY1 to RY4 at the end of this file): each
// run line ends the turn after a started run, naming the card above and
// Approvals; each wait line reads a run at most once a turn, only when the
// person asks, and ends the turn on a running answer; the workflow logs line
// the same; the agentic Steps 1 to 3 and the workflow Steps 3 and 5 read
// their wait once and end the turn on a running answer, and agentic Step 3
// no longer says the wait blocks until the execution finishes; each run
// line names `task` as the person's own words (RY5) (1576 characters more in
// each workflow prompt, 1210 in each agentic prompt);
// the execute and operator pins were re-measured for run-then-yield-C2
// (RY6 at the end of this file): the execute prompt's Step 3 line and the
// operator prompt's timeout line end the turn on a running wait in place of
// waiting again or calling the wait until it ends (15 characters more in the
// execute prompt, 93 in the operator prompt);
// the agentic and workflow pins (and their chat-uploads forms) were
// re-measured for gate-promise-wording (GP1 and GP2 at the end of this file):
// each run line says each Human gate appears on that card and in Approvals,
// the badge in the header, forbids any promise for after the turn, and reads
// a run asked about later once (399 characters more in each);
// the agentic and workflow pins (and their chat-uploads forms) were
// re-measured for card-above-wording (CA1 to CA3 at the end of this file):
// each card the answer names is the card above it, and the agentic run line
// (Step 3) and the workflow test-execution line (Step 5) carry the run line's
// sentence that promises nothing for after the turn (270 characters more in
// each);
// the agentic, workflow and operator pins (and the agentic and workflow
// chat-uploads forms) were re-measured for failed-run-told-once (FR1 to FR4
// at the end of this file): each mode whose tools read a run tells a failed
// run once, with the run's own failure sentence, and ends the turn there (a
// paragraph in the agentic and workflow prompts, a bullet of the operator's
// failures list); the agentic Step 1 workflow branch and run line end with
// the no-promise sentence, and the transcription line sends the model to no
// wait and teaches `input.audio_path` (954 characters more in each agentic
// prompt, 436 in each workflow prompt, 437 in the operator prompt);
// every pin was re-measured for connection-needs-server (Zaru ADR-0070 D3
// (b), test/connection-needs-server.test.ts): the three sentences on a
// missing connection are appended to every mode's prompt, after its own text
// and before any chosen context or profile (598 characters more in each);
// every other pin stands as it was.
const UNCHANGED_PROMPTS: Array<[string, () => ReturnType<typeof getZaruInit>, number, string]> = [
  ["agentic", () => getZaruInit("agentic"), 21238, "e1d5da21cd2833cedbe50889731b969b8e8e45f475b3fb22b441fc808ad96404"],
  ["agentic+chat-uploads", () => getZaruInit("agentic", new Set(["chat-uploads"])), 25048, "5caa9c86f5d7cba3496f577788829af65e583e56868b448955bdcfb42e220124"],
  ["workflow", () => getZaruInit("workflow"), 17642, "1c247bf2d6a75e385b8c2a72cfa5f5d8499546861e2484e3a1257352299505c1"],
  ["workflow+chat-uploads", () => getZaruInit("workflow", new Set(["chat-uploads"])), 21452, "8f8867ee82c1db329f7271238561ce100b22c8a857e9bdc90ee9ef06f9309a15"],
  ["execute", () => getZaruInit("execute"), 13311, "38c26aff0314050a56fed068f43bae639f791c3c02aaa8ce6fe5f36febc0bf46"],
  ["live", () => getZaruInit("live", new Set(["live"]), "browser"), 9156, "8630ff490dfdb338538993ba9d8ac202f9375207c4a143d3ba5bc71d580cc68a"],
  ["vibecode", () => getZaruInit("vibecode", new Set(["vibecode"]), "browser"), 12586, "6760042f288e3f03cc79c0071f51fd4cd81bf74d757ccd73b731737567c29d44"],
  ["operator", () => getZaruInit("operator", new Set(), undefined, { isOperator: true, tier: "operator" }), 11847, "910e942b7045214c7c4ded686f81ec7097216c501e9932cb753fdb43c1f38b71"],
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
  const missing = ["aegis.agent.update", "aegis.workflow.update", "aegis.agent.export"].filter(
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
  "The tools whose names begin with mail. reach the person's mailbox they chose above the chat input: list and read their threads in the inbox, Sent, Drafts, Trash, Archive or all their mail by 'folder', save an attachment to their files, flag threads and mark them read or unread, and nothing else until they ask. A call names which mailbox in 'mailbox' when several are chosen; with one chosen it is set for you. Read only what the message asks for; never send, forward, archive, delete or move mail unless the message asks, and say so when you do. If a call is refused, tell the person in one sentence and answer without it.";

const genericSentence = (server: string) =>
  `The tools whose names begin with ${server}. reach the person's ${server} connection as their credential allows. Read and change only what the message asks for. If a call is refused, tell the person in one sentence and answer without it. A call may wait for the person's approval; when one does, say so and wait for their answer.`;

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

// AEGIS ADR-137 R12 and R13: the generic sentence, for a chosen server with no
// sentence of its own, ends with one sentence on approval; the sentences of the
// servers in the table are unchanged, and nothing taught names a decision record.

const APPROVAL_SENTENCE = "A call may wait for the person's approval; when one does, say so and wait for their answer.";

test("R12: the generic sentence for a server not in the table ends with the approval sentence, in every mode", () => {
  const complaints: string[] = [];
  for (const [mode, gained] of teachingsFor({ zeta: [BINDING_A] })) {
    if (gained !== taught(genericSentence("zeta"))) {
      complaints.push(`${mode}: zeta not taught the generic sentence with the approval sentence, got ${JSON.stringify(gained.slice(-200))}`);
    }
    if (!gained.endsWith(` ${APPROVAL_SENTENCE}`)) complaints.push(`${mode}: the generic sentence does not end with the approval sentence`);
  }
  assert.deepEqual(complaints, []);
});

test("R12: the table's servers keep their own sentences byte for byte, and none gains the approval sentence", () => {
  const complaints: string[] = [];
  // GitHub's sentence pinned exactly, as taught alone.
  for (const [mode, gained] of teachingsFor({ github: [BINDING_A] })) {
    if (gained !== taught(GITHUB_SENTENCE)) complaints.push(`${mode}: GitHub's sentence changed, got ${JSON.stringify(gained.slice(-200))}`);
  }
  for (const [mode, gained] of teachingsFor({
    caldav: [BINDING_C],
    imap: [BINDING_B],
    github: [BINDING_A],
    "nuclear-notes": BINDING_A,
  })) {
    if (gained !== taught(NUCLEAR_NOTES_SENTENCE, GITHUB_SENTENCE, MAILBOX_SENTENCE, CALENDAR_SENTENCE)) {
      complaints.push(`${mode}: the table's sentences changed, got ${JSON.stringify(gained.slice(-200))}`);
    }
    if (gained.includes(APPROVAL_SENTENCE)) complaints.push(`${mode}: a table server taught the approval sentence`);
  }
  assert.deepEqual(complaints, []);
});

test("R12: with a server not in the table chosen, each of the eight pinned prompts is unchanged and only gains the generic teaching", () => {
  const complaints: string[] = [];
  for (const [name, mode, caps, runtime, user] of PINNED_ARGUMENTS) {
    const [, , length, sha256] = UNCHANGED_PROMPTS.find(([pinned]) => pinned === name)!;
    const prompt = getZaruInit(mode, caps, runtime, user, { zeta: [BINDING_A] })!.system_prompt;
    if (createHash("sha256").update(prompt.slice(0, length)).digest("hex") !== sha256) {
      complaints.push(`'${name}': the pinned prompt changed before the teaching`);
    }
    if (prompt.slice(length) !== taught(genericSentence("zeta"))) {
      complaints.push(`'${name}': gained ${JSON.stringify(prompt.slice(length, length + 160))}, not the generic teaching`);
    }
  }
  assert.deepEqual(complaints, []);
});

test("R13: the generic teaching, as taught, names no decision record", () => {
  // The facing-text test's pattern (test/facing-text-no-record-refs.test.ts).
  const RECORD_REFERENCE = /ADR-[0-9]|CD-[0-9]|ADR [0-9]|[Dd]ecision record|security audit 0|audit 0[0-9][0-9]|§[0-9]/;
  const complaints: string[] = [];
  for (const [mode, gained] of teachingsFor({ zeta: [BINDING_A, BINDING_B] })) {
    if (!gained.includes(APPROVAL_SENTENCE)) complaints.push(`${mode}: the approval sentence not taught`);
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
// orchestrator's listing once the person's context admits them. N24: in the
// Agentic and Workflow modes the model makes no schedule itself; it proposes
// one with zaru.schedule, naming what it ran, and the person makes it from the
// card. aegis.schedule.create and aegis.schedule.update leave those modes'
// lists and teaching; the sentence that taught making a schedule is replaced
// by one teaching the proposal, where each names its starting tool, and no
// other mode's prompt holds it.
// ---------------------------------------------------------------------------

/** The sentence N24 replaced: it taught the model to make the schedule itself. */
const MAKE_SCHEDULE_SENTENCE =
  "To run an agent or a workflow later or again and again, make a schedule with aegis.schedule.create; it runs as the person, and anything it would send waits for their approval.";

const SCHEDULE_SENTENCE =
  "To run it later or again and again, propose it with zaru.schedule, naming the agent or workflow you ran; the person makes the schedule from the card.";

/** The two schedule tools that make or change a schedule, which no longer reach the Agentic and Workflow modes. */
const MAKING_TOOLS = ["aegis.schedule.create", "aegis.schedule.update"];

test("N24: the agentic and workflow prompts hold the proposal-from-the-run sentence once, beside their starting tool, right before the proposal and target sentences; no other mode's prompt holds it", () => {
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
      failures.push(`the ${name} prompt holds the proposal-from-the-run sentence ${count} times, not once`);
      continue;
    }
    const start = prompt.indexOf(from);
    const end = prompt.indexOf(to, start);
    const at = prompt.indexOf(SCHEDULE_SENTENCE);
    if (!(start >= 0 && start < at && at < end)) failures.push(`the ${name} prompt's proposal-from-the-run sentence is not in its ${from.slice(2)}`);
    if (prompt.slice(at - before.length, at) !== before) failures.push(`the ${name} prompt's proposal-from-the-run sentence does not follow "${before.trim()}"`);
    // N17's proposal sentence and N20's sentence on its target follow it, in
    // that order, and end the paragraph.
    const ending = ` ${PROPOSE_SENTENCE} ${PROPOSAL_TARGET_SENTENCE}\n\n`;
    if (prompt.slice(at + SCHEDULE_SENTENCE.length, at + SCHEDULE_SENTENCE.length + ending.length) !== ending)
      failures.push(`the ${name} prompt's proposal-from-the-run sentence is not followed by the proposal sentence and its target sentence, ending its paragraph`);
  }
  for (const [mode, init] of ALL_MODES) {
    if (mode === "agentic" || mode === "workflow") continue;
    if (init!.system_prompt.includes(SCHEDULE_SENTENCE)) failures.push(`the ${mode} prompt holds the proposal-from-the-run sentence`);
    if (init!.system_prompt.includes("aegis.schedule.")) failures.push(`the ${mode} prompt names a schedule tool`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("N24: no prompt teaches making or changing a schedule: neither aegis.schedule.create nor aegis.schedule.update nor the sentence that taught it is in any mode's prompt", () => {
  const failures: string[] = [];
  for (const [name, init] of [
    ...ALL_MODES,
    ["agentic+chat-uploads", getZaruInit("agentic", new Set(["chat-uploads"]))] as [string, ReturnType<typeof getZaruInit>],
    ["workflow+chat-uploads", getZaruInit("workflow", new Set(["chat-uploads"]))] as [string, ReturnType<typeof getZaruInit>],
  ]) {
    const prompt = init!.system_prompt;
    for (const tool of MAKING_TOOLS) if (prompt.includes(tool)) failures.push(`the ${name} prompt names ${tool}`);
    if (prompt.includes(MAKE_SCHEDULE_SENTENCE)) failures.push(`the ${name} prompt holds the sentence that taught making a schedule`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

const SCHEDULE_TOOLS = [
  "aegis.schedule.list",
  "aegis.schedule.get",
  "aegis.schedule.pause",
  "aegis.schedule.resume",
  "aegis.schedule.run_now",
  "aegis.schedule.delete",
  "aegis.schedule.runs",
];

test("N13, N24: the agentic and workflow tool lists hold the seven schedule tools (seven from N26, 2026-10-10: aegis.schedule.run_now added) that read, pause, resume or delete, after aegis.workflow.wait, and neither aegis.schedule.create nor aegis.schedule.update; no other mode's list holds one", () => {
  const failures: string[] = [];
  for (const [mode, init] of ALL_MODES) {
    const tools = init!.available_tools;
    if (mode === "agentic" || mode === "workflow") {
      const listed = tools;
      const at = listed.indexOf("aegis.workflow.wait");
      const after = listed.slice(at + 1, at + 1 + SCHEDULE_TOOLS.length);
      if (at < 0 || JSON.stringify(after) !== JSON.stringify(SCHEDULE_TOOLS))
        failures.push(`the ${mode} list does not hold the seven schedule tools (seven from N26, 2026-10-10) after aegis.workflow.wait, got ${JSON.stringify(after)}`);
      for (const tool of MAKING_TOOLS) if (tools.includes(tool)) failures.push(`the ${mode} list holds ${tool}`);
      const held = tools.filter((tool) => tool.startsWith("aegis.schedule."));
      if (held.length !== SCHEDULE_TOOLS.length) failures.push(`the ${mode} list holds ${held.length} schedule tools: ${held.join(", ")}`);
    } else {
      const held = tools.filter((tool) => tool.startsWith("aegis.schedule."));
      if (held.length) failures.push(`the ${mode} list holds ${held.join(", ")}`);
    }
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

// ---------------------------------------------------------------------------
// AEGIS ADR-139 N17: an offer to keep watching is a schedule proposed as a
// card. `zaru.schedule` is available in every mode as `zaru.mode` is, and the
// agentic and workflow prompts each hold one sentence, verbatim from the
// record, telling the model to propose a schedule instead of asking in words.
// N19 replaces the chat prompt's: there a proposal names an agent or workflow
// the conversation already named or ran, and otherwise the model offers
// Agentic mode. N20 follows the agentic and workflow prompts' sentence with
// one naming the target that was found or made and ran.
// ---------------------------------------------------------------------------

const PROPOSE_SENTENCE =
  "When you would offer to keep an eye on something or do it again later, propose a schedule with zaru.schedule instead of asking in words.";

const CHAT_SCHEDULE_SENTENCES =
  'When the person asks you to keep an eye on something, check back or do something again later, propose a schedule with zaru.schedule only for an agent or workflow of theirs that this conversation has already named or run, and name it as the target. Otherwise call zaru.mode with mode "agentic": there the one that does it is found or made and run once, and the schedule is proposed from that run. Never propose a schedule with no target.';

const PROPOSAL_TARGET_SENTENCE =
  "Name as its target the agent or workflow you found or made and ran for this request.";

test("N17: every mode's tool list holds zaru.schedule once, right after zaru.mode", () => {
  const failures: string[] = [];
  for (const [mode, init] of ALL_MODES) {
    const tools = init!.available_tools;
    const count = tools.filter((tool) => tool === "zaru.schedule").length;
    if (count !== 1) failures.push(`the ${mode} list holds zaru.schedule ${count} times, not once`);
    else if (tools[tools.indexOf("zaru.schedule") - 1] !== "zaru.mode")
      failures.push(`the ${mode} list does not hold zaru.schedule right after zaru.mode`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("N17, N20: the agentic and workflow prompts hold the proposal sentence once, followed by the target sentence ending its paragraph; no other mode's prompt holds either", () => {
  const failures: string[] = [];
  const holders: Array<[string, Set<string>]> = [
    ["agentic", new Set()],
    ["agentic", new Set(["chat-uploads"])],
    ["workflow", new Set()],
    ["workflow", new Set(["chat-uploads"])],
  ];
  const before = `${SCHEDULE_SENTENCE} `;
  for (const [mode, caps] of holders) {
    const name = caps.size ? `${mode}+chat-uploads` : mode;
    const prompt = getZaruInit(mode, caps)!.system_prompt;
    for (const [what, sentence] of [["proposal", PROPOSE_SENTENCE], ["target", PROPOSAL_TARGET_SENTENCE]]) {
      const count = prompt.split(sentence).length - 1;
      if (count !== 1) failures.push(`the ${name} prompt holds the ${what} sentence ${count} times, not once`);
    }
    const at = prompt.indexOf(PROPOSE_SENTENCE);
    if (at < 0) continue;
    if (prompt.slice(at - before.length, at) !== before) failures.push(`the ${name} prompt's proposal sentence does not follow "${before.trim()}"`);
    const after = ` ${PROPOSAL_TARGET_SENTENCE}\n\n`;
    if (prompt.slice(at + PROPOSE_SENTENCE.length, at + PROPOSE_SENTENCE.length + after.length) !== after)
      failures.push(`the ${name} prompt's proposal sentence is not followed by the target sentence, ending its paragraph`);
  }
  for (const [mode, init] of ALL_MODES) {
    if (mode === "agentic" || mode === "workflow") continue;
    for (const [what, sentence] of [["proposal", PROPOSE_SENTENCE], ["target", PROPOSAL_TARGET_SENTENCE]])
      if (init!.system_prompt.includes(sentence)) failures.push(`the ${mode} prompt holds the ${what} sentence`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("N19: the chat prompt holds its schedule sentences once, after the mode offer and ending its paragraph; no other mode's prompt holds them, and only chat, agentic and workflow name zaru.schedule", () => {
  const failures: string[] = [];
  const before = "which you offer with zaru.mode. ";
  for (const caps of [new Set<string>(), new Set(["chat-uploads"])]) {
    const name = caps.size ? "chat+chat-uploads" : "chat";
    const prompt = getZaruInit("chat", caps)!.system_prompt;
    const count = prompt.split(CHAT_SCHEDULE_SENTENCES).length - 1;
    if (count !== 1) {
      failures.push(`the ${name} prompt holds its schedule sentences ${count} times, not once`);
      continue;
    }
    const at = prompt.indexOf(CHAT_SCHEDULE_SENTENCES);
    if (prompt.slice(at - before.length, at) !== before) failures.push(`the ${name} prompt's schedule sentences do not follow "${before.trim()}"`);
    if (prompt.slice(at + CHAT_SCHEDULE_SENTENCES.length, at + CHAT_SCHEDULE_SENTENCES.length + 2) !== "\n\n")
      failures.push(`the ${name} prompt's schedule sentences do not end their paragraph`);
  }
  for (const [mode, init] of ALL_MODES) {
    if (mode !== "chat" && init!.system_prompt.includes(CHAT_SCHEDULE_SENTENCES)) failures.push(`the ${mode} prompt holds the chat schedule sentences`);
    if (mode !== "chat" && mode !== "agentic" && mode !== "workflow" && init!.system_prompt.includes("zaru.schedule"))
      failures.push(`the ${mode} prompt names zaru.schedule`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

// ---------------------------------------------------------------------------
// The person's other conversations (Zaru ADR-0059 C9, C10). Jeshua, asking
// Zaru Web "Do you have access to our other conversations?", was told no:
// the prompt taught memory alone, and no mode listed a conversation tool.
// Every mode's prompt now carries the teaching section after the memory
// section, and every mode's list the three tools after zaru.memory.set.
// ---------------------------------------------------------------------------

const CONVERSATIONS_SECTION = `# YOUR CONVERSATIONS WITH THIS USER

You can read this person's other conversations with you, the ones on Zaru and the ones through their other apps: zaru.conversations.list lists them newest first, zaru.conversations.search finds the ones that mention some words, and zaru.conversations.read reads one, a page at a time. When they ask about an earlier conversation, or whether you can see your past conversations, say yes and read before you answer; never guess what was said. The conversation you are in is already in front of you. Memory stays the short profile you keep; a conversation is read when it is needed and is not copied into memory.`;

const CONVERSATION_TOOLS = ["zaru.conversations.list", "zaru.conversations.read", "zaru.conversations.search"];

const EVERY_PROMPT: Array<[string, ReturnType<typeof getZaruInit>]> = [
  ...ALL_MODES,
  ["agentic+chat-uploads", getZaruInit("agentic", new Set(["chat-uploads"]))],
  ["workflow+chat-uploads", getZaruInit("workflow", new Set(["chat-uploads"]))],
];

test("C10: every mode's prompt holds the conversations section verbatim, once, right after the memory section", () => {
  const failures: string[] = [];
  const memoryEnd = "what you write here is what every future session sees.\n\n";
  for (const [name, init] of EVERY_PROMPT) {
    const prompt = init!.system_prompt;
    const count = prompt.split(CONVERSATIONS_SECTION).length - 1;
    if (count !== 1) {
      failures.push(`the ${name} prompt holds the conversations section ${count} times, not once`);
      continue;
    }
    const at = prompt.indexOf(CONVERSATIONS_SECTION);
    if (prompt.slice(at - memoryEnd.length, at) !== memoryEnd)
      failures.push(`the ${name} prompt's conversations section does not follow the memory section`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("C10: the memory section still calls memory a curated profile, not a chat transcript log", () => {
  for (const [name, init] of EVERY_PROMPT) {
    assert.ok(
      init!.system_prompt.includes("it is a curated profile, not a chat transcript log"),
      `the ${name} prompt keeps the memory sentence`,
    );
  }
});

test("C9: every mode's tool list holds the three conversation tools once each, right after zaru.memory.set", () => {
  const failures: string[] = [];
  for (const [mode, init] of ALL_MODES) {
    const tools = init!.available_tools;
    const at = tools.indexOf("zaru.memory.set");
    const after = tools.slice(at + 1, at + 1 + CONVERSATION_TOOLS.length);
    if (at < 0 || JSON.stringify(after) !== JSON.stringify(CONVERSATION_TOOLS))
      failures.push(`the ${mode} list holds ${JSON.stringify(after)} after zaru.memory.set`);
    for (const tool of CONVERSATION_TOOLS) {
      const count = tools.filter((t) => t === tool).length;
      if (count !== 1) failures.push(`the ${mode} list holds ${tool} ${count} times`);
    }
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

// AEGIS ADR-140 D12: a chosen profile, read by the server as the person,
// appends its own heading after everything else, naming the profile, its
// default Nuclear Notes workspace and the person's instructions for it, each
// only when the profile has one; with no profile every prompt is unchanged.

const PROFILE_HEADING = "# THE PERSON'S CHOSEN PROFILE";

const FULL_PROFILE = {
  name: "Fundraising",
  notes_workspace: "fundraising-notes",
  instructions: "Answer investors in two short paragraphs.\nNever attach a file.",
};

const BARE_PROFILE = { name: "Reading only", notes_workspace: null, instructions: null };

test("D12: a chosen profile appends one heading at the end of each pinned prompt, with its name, notes workspace and instructions, the prompt's own bytes unchanged", () => {
  const complaints: string[] = [];
  for (const [name, mode, caps, runtime, user] of PINNED_ARGUMENTS) {
    const [, , length, sha256] = UNCHANGED_PROMPTS.find(([pinned]) => pinned === name)!;
    const prompt = getZaruInit(mode, caps, runtime, user, {}, FULL_PROFILE)!.system_prompt;
    if (createHash("sha256").update(prompt.slice(0, length)).digest("hex") !== sha256) {
      complaints.push(`'${name}': the pinned prompt changed before the profile`);
    }
    const gained = prompt.slice(length);
    if (!gained.startsWith(`\n\n${PROFILE_HEADING}\n\n`)) complaints.push(`'${name}': gained ${JSON.stringify(gained.slice(0, 80))}`);
    if (gained.split(PROFILE_HEADING).length !== 2) complaints.push(`'${name}': the heading was not taught once`);
    for (const part of [FULL_PROFILE.name, FULL_PROFILE.notes_workspace, FULL_PROFILE.instructions]) {
      if (!gained.includes(part)) complaints.push(`'${name}': ${JSON.stringify(part)} not taught`);
    }
  }
  for (const [mode, caps, runtime] of CONTEXT_MODES) {
    const without = getZaruInit(mode, caps, runtime, CONTEXT_OPERATOR)!.system_prompt;
    const withProfile = getZaruInit(mode, caps, runtime, CONTEXT_OPERATOR, {}, FULL_PROFILE)!.system_prompt;
    if (!withProfile.startsWith(without) || !withProfile.slice(without.length).startsWith(`\n\n${PROFILE_HEADING}`)) {
      complaints.push(`${mode}: the profile was not appended to the mode's own prompt`);
    }
  }
  assert.deepEqual(complaints, []);
});

test("D12: a profile with no notes workspace and no instructions teaches its heading and name and neither of them", () => {
  const complaints: string[] = [];
  for (const [mode, caps, runtime] of CONTEXT_MODES) {
    const without = getZaruInit(mode, caps, runtime, CONTEXT_OPERATOR)!.system_prompt;
    const full = getZaruInit(mode, caps, runtime, CONTEXT_OPERATOR, {}, FULL_PROFILE)!.system_prompt.slice(without.length);
    const bare = getZaruInit(mode, caps, runtime, CONTEXT_OPERATOR, {}, BARE_PROFILE)!.system_prompt.slice(without.length);
    if (!bare.startsWith(`\n\n${PROFILE_HEADING}\n\n`) || !bare.includes(BARE_PROFILE.name)) complaints.push(`${mode}: bare taught ${JSON.stringify(bare)}`);
    if (bare.split("\n\n").length >= full.split("\n\n").length) complaints.push(`${mode}: the bare profile taught as many paragraphs as the full one`);
    if (bare.includes("null") || bare.includes("undefined")) complaints.push(`${mode}: the bare profile taught ${JSON.stringify(bare)}`);
  }
  assert.deepEqual(complaints, []);
});

test("D12: with no profile chosen every pinned prompt is unchanged, and the profile heading appears nowhere", () => {
  const complaints: string[] = [];
  for (const [name, mode, caps, runtime, user] of PINNED_ARGUMENTS) {
    const [, , length, sha256] = UNCHANGED_PROMPTS.find(([pinned]) => pinned === name)!;
    for (const contexts of [{}, { "nuclear-notes": [BINDING_A] }] as Contexts[]) {
      const prompt = getZaruInit(mode, caps, runtime, user, contexts, undefined)!.system_prompt;
      if (prompt.includes(PROFILE_HEADING)) complaints.push(`'${name}' ${JSON.stringify(contexts)}: the profile heading taught`);
      if (Object.keys(contexts).length === 0 && (prompt.length !== length || createHash("sha256").update(prompt).digest("hex") !== sha256)) {
        complaints.push(`'${name}': the pinned prompt changed`);
      }
    }
  }
  assert.deepEqual(complaints, []);
});

// ---------------------------------------------------------------------------
// AEGIS ADR-141 F11 (Trigger T6): a person or the fleet starts a workflow and
// answers its gates from the workflow scope. The workflow mode's tool list
// gains aegis.workflow.run and aegis.workflow.signal, after
// aegis.workflow.logs; the agentic and operator lists keep them where they
// were, and every mode's prompt is untouched (the W41 and D3 pins above).
// ---------------------------------------------------------------------------

/** The workflow mode's tool list as it stood at aegis-mcp-tools 3affd36. */
const WORKFLOW_TOOLS_AT_3AFFD36 = [
  "zaru.mode",
  "zaru.schedule",
  "zaru.docs",
  "zaru.memory.get",
  "zaru.memory.set",
  "zaru.conversations.list",
  "zaru.conversations.read",
  "zaru.conversations.search",
  "aegis.workflow.generate",
  "aegis.workflow.list",
  "aegis.workflow.logs",
  "aegis.agent.generate",
  "aegis.agent.wait",
  "aegis.agent.list",
  "aegis.agent.logs",
  "aegis.schema.get",
  "aegis.schema.validate",
  "aegis.task.execute",
  "aegis.task.wait",
  "aegis.workflow.wait",
  "aegis.schedule.list",
  "aegis.schedule.get",
  "aegis.schedule.pause",
  "aegis.schedule.resume",
  "aegis.schedule.delete",
  "aegis.schedule.runs",
  "aegis.execution.file",
  "aegis.goal.cancel",
];

/** The agentic mode's tool list as it stood at aegis-mcp-tools 3affd36. */
const AGENTIC_TOOLS_AT_3AFFD36 = [
  "zaru.mode",
  "zaru.schedule",
  "zaru.docs",
  "zaru.memory.get",
  "zaru.memory.set",
  "zaru.conversations.list",
  "zaru.conversations.read",
  "zaru.conversations.search",
  "aegis.agent.generate",
  "aegis.agent.wait",
  "aegis.agent.list",
  "aegis.agent.search",
  "aegis.workflow.search",
  "aegis.workflow.run",
  "aegis.workflow.wait",
  "aegis.schedule.list",
  "aegis.schedule.get",
  "aegis.schedule.pause",
  "aegis.schedule.resume",
  "aegis.schedule.delete",
  "aegis.schedule.runs",
  "aegis.agent.logs",
  "aegis.task.execute",
  "aegis.task.wait",
  "aegis.task.list",
  "aegis.task.logs",
  "aegis.task.cancel",
  "aegis.tools.list",
  "aegis.tools.search",
  "aegis.execution.file",
  "aegis.goal.cancel",
];

/** The operator mode's tool list as it stood at aegis-mcp-tools 3affd36. */
const OPERATOR_TOOLS_AT_3AFFD36 = [
  "zaru.mode",
  "zaru.schedule",
  "zaru.docs",
  "zaru.memory.get",
  "zaru.memory.set",
  "zaru.conversations.list",
  "zaru.conversations.read",
  "zaru.conversations.search",
  "aegis.agent.generate",
  "aegis.agent.wait",
  "aegis.agent.list",
  "aegis.agent.logs",
  "aegis.task.execute",
  "aegis.task.wait",
  "aegis.task.list",
  "aegis.task.logs",
  "aegis.task.cancel",
  "aegis.tools.list",
  "aegis.tools.search",
  "aegis.execution.file",
  "aegis.workflow.generate",
  "aegis.workflow.list",
  "aegis.workflow.logs",
  "aegis.workflow.wait",
  "aegis.schema.get",
  "aegis.schema.validate",
  "aegis.execute.intent",
  "aegis.execute.status",
  "aegis.execute.wait",
  "aegis.agent.create",
  "aegis.agent.update",
  "aegis.agent.export",
  "aegis.agent.delete",
  "aegis.workflow.create",
  "aegis.workflow.update",
  "aegis.workflow.signal",
  "aegis.workflow.delete",
  "aegis.task.remove",
  "aegis.goal.cancel",
];

test("F11: the workflow mode's tool list holds aegis.workflow.run once, right after aegis.workflow.logs, and no aegis.workflow.signal (aegis.git.list, added after aegis.workflow.run, aside)", () => {
  const tools = getZaruInit("workflow")!.available_tools.filter((t) => t !== "aegis.git.list");
  assert.equal(tools.filter((t) => t === "aegis.workflow.run").length, 1, "the workflow list holds aegis.workflow.run once");
  assert.equal(tools.includes("aegis.workflow.signal"), false, "the workflow list holds aegis.workflow.signal");
  const at = tools.indexOf("aegis.workflow.logs");
  assert.deepEqual(tools.slice(at + 1, at + 3), ["aegis.workflow.run", "aegis.workflow.create"]);
});

test("F11: the workflow mode's tool list is its list at 3affd36 with only aegis.workflow.run added (and, from N26 of 2026-10-10, aegis.schedule.run_now; aegis.git.list; and, from 2026-10-12, aegis.workflow.create and aegis.workflow.update); aegis.workflow.signal, added with the run, left it on 2026-10-13", () => {
  const tools = getZaruInit("workflow")!.available_tools;
  assert.deepEqual(
    tools.filter(
      (t) =>
        t !== "aegis.workflow.run" &&
        t !== "aegis.schedule.run_now" &&
        t !== "aegis.git.list" &&
        t !== "aegis.workflow.create" &&
        t !== "aegis.workflow.update" &&
        t !== "zaru.connection.needed", // connection-needs-server-C1
    ),
    WORKFLOW_TOOLS_AT_3AFFD36,
  );
  assert.equal(tools.length, WORKFLOW_TOOLS_AT_3AFFD36.length + 6);
});

test("F11: the agentic tool list is unchanged (its aegis.schedule.run_now, aegis.git.list and aegis.image.generate aside, added by N26 of 2026-10-10 and after it) and still holds aegis.workflow.run; the operator tool list is unchanged but for aegis.workflow.signal, which it no longer holds", () => {
  const agentic = getZaruInit("agentic")!.available_tools;
  const operator = getZaruInit("operator", new Set(), undefined, { isOperator: true, tier: "operator" })!.available_tools;
  assert.deepEqual(
    agentic.filter(
      (t) =>
        t !== "aegis.schedule.run_now" &&
        t !== "aegis.git.list" &&
        t !== "aegis.image.generate" &&
        t !== "zaru.connection.needed", // connection-needs-server-C1
    ),
    AGENTIC_TOOLS_AT_3AFFD36,
  );
  assert.deepEqual(
    operator.filter((t) => t !== "zaru.connection.needed"), // connection-needs-server-C1
    OPERATOR_TOOLS_AT_3AFFD36.filter((t) => t !== "aegis.workflow.signal"),
  );
  assert.ok(agentic.includes("aegis.workflow.run"));
  assert.ok(!operator.includes("aegis.workflow.signal"));
});

// ---------------------------------------------------------------------------
// AEGIS ADR-139 N26: a schedule runs now on the person's word. The Zaru MCP
// server offers the orchestrator's aegis.schedule.run_now in every mode whose
// tool list carries aegis.schedule.get, right after aegis.schedule.resume; the
// tool is listed from the orchestrator's catalogue and relayed as every other
// aegis.* tool is, so the lists are the whole change, and no mode's prompt
// changes (the eight pins above).
// ---------------------------------------------------------------------------

const RUN_NOW = "aegis.schedule.run_now";

test("N26: each mode whose tool list carries aegis.schedule.get carries aegis.schedule.run_now once, right after aegis.schedule.resume; no other mode carries it", () => {
  const failures: string[] = [];
  let carrying = 0;
  for (const [mode, init] of ALL_MODES) {
    const tools = init!.available_tools;
    const count = tools.filter((tool) => tool === RUN_NOW).length;
    if (tools.includes("aegis.schedule.get")) {
      carrying += 1;
      if (count !== 1) failures.push(`the ${mode} list carries aegis.schedule.get and holds ${RUN_NOW} ${count} times, not once`);
      else if (tools[tools.indexOf(RUN_NOW) - 1] !== "aegis.schedule.resume")
        failures.push(`the ${mode} list does not hold ${RUN_NOW} right after aegis.schedule.resume`);
    } else if (count !== 0) {
      failures.push(`the ${mode} list holds ${RUN_NOW} without aegis.schedule.get`);
    }
  }
  if (carrying === 0) failures.push("no mode's list carries aegis.schedule.get");
  assert.deepEqual(failures, [], failures.join("; "));
});

test("N26: the eight pinned prompts are unchanged byte for byte and none names aegis.schedule.run_now", () => {
  assert.equal(UNCHANGED_PROMPTS.length, 8);
  const failures: string[] = [];
  for (const [name, init, length, sha256] of UNCHANGED_PROMPTS) {
    const prompt = init()!.system_prompt;
    if (prompt.length !== length || createHash("sha256").update(prompt).digest("hex") !== sha256)
      failures.push(`the '${name}' prompt changed`);
    if (prompt.includes(RUN_NOW)) failures.push(`the '${name}' prompt names ${RUN_NOW}`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

// ---------------------------------------------------------------------------
// A workflow run on a repository names the person's binding by its id. The
// Zaru MCP server offers the orchestrator's aegis.git.list, which lists the
// person's git repository bindings, in each mode whose tool list carries
// aegis.workflow.run (agentic and workflow), right after it; the tool is
// listed from the orchestrator's catalogue and relayed as every other aegis.*
// tool is, so the lists are the whole change, and no mode's prompt changes
// (the eight pins above).
// ---------------------------------------------------------------------------

const GIT_LIST = "aegis.git.list";

test("The agentic and workflow tool lists hold aegis.git.list once, right after aegis.workflow.run; no other mode's list holds it", () => {
  const failures: string[] = [];
  for (const [mode, init] of ALL_MODES) {
    const tools = init!.available_tools;
    const count = tools.filter((tool) => tool === GIT_LIST).length;
    if (mode === "agentic" || mode === "workflow") {
      if (count !== 1) failures.push(`the ${mode} list holds ${GIT_LIST} ${count} times, not once`);
      else if (tools[tools.indexOf(GIT_LIST) - 1] !== "aegis.workflow.run")
        failures.push(`the ${mode} list does not hold ${GIT_LIST} right after aegis.workflow.run`);
    } else if (count !== 0) {
      failures.push(`the ${mode} list holds ${GIT_LIST}`);
    }
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("No pinned prompt names aegis.git.list", () => {
  const failures: string[] = [];
  for (const [name, init] of UNCHANGED_PROMPTS) {
    if (init()!.system_prompt.includes(GIT_LIST)) failures.push(`the '${name}' prompt names ${GIT_LIST}`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

// ---------------------------------------------------------------------------
// AEGIS ADR-143 I2, I3 and T8: the companion makes an image with the
// orchestrator's aegis.image.generate. The tool is listed from the
// orchestrator's catalogue and relayed as every other aegis.* tool is; the
// agentic and execute modes admit it, right after aegis.execution.file, and
// each of their prompts teaches it in one paragraph of its TOOL KNOWLEDGE,
// right after the aegis.execution.file entry. No other mode admits or names it.
// ---------------------------------------------------------------------------

const IMAGE_GENERATE = "aegis.image.generate";

/** The TOOL KNOWLEDGE line as T8's second leg shortened it: the tool's arguments and its refusal. */
const IMAGE_TEACHING =
  "- `aegis.image.generate`: Make an image. Takes `prompt` and, optionally, `size` as `<width>x<height>`, such as `1024x768`. When the answer says this node has no image generation model, say so in one sentence and offer nothing in its place.";

/** The TOOL KNOWLEDGE line as aegis-mcp-tools 13a3cb5d taught it. */
const IMAGE_TEACHING_AT_13A3CB5D =
  "- `aegis.image.generate`: Make an image. When the person asks for a picture, an illustration, a logo, a diagram drawn as an image or any other image to be made, call aegis.image.generate directly with their words as `prompt` and, when they name a size, `size` as `<width>x<height>`, such as `1024x768`. The chat shows the person each of the answer's `files` as an image card: say what was made in one sentence, and do not describe the image in its place. When the answer says this node has no image generation model, say so in one sentence and offer nothing in its place. Never say an image was made without this tool's answer.";

/** The image exception (T8's second leg), one paragraph before the agentic and execute modes' mandatory sequence. */
const IMAGE_REQUEST_EXCEPTION =
  "A request for an image to be made is the one exception. A picture, an illustration, a logo, a diagram drawn as an image or any other image to be made is not a task for your 100monkeys: it starts no agent, no workflow and no goal, and the mandatory sequence below is not followed for it. Its one act is the tool call aegis.image.generate, with the person's words as `prompt` and, when they name a size, that size as `size`. aegis.agent.generate, aegis.task.execute and aegis.workflow.run are never the call for an image, and you never say you are calling aegis.image.generate while you call another tool. The chat shows the person each of the answer's `files` as an image card, so your reply names what was made in one sentence and does not describe the image in its place. Never say an image was made without this tool's answer.";

const EXECUTION_FILE_KNOWLEDGE =
  "- `aegis.execution.file`: Read a file from a completed execution's workspace. Takes execution_id and path. The path can include or exclude the /workspace/ prefix — both work.";

/** The prompts aegis.image.generate's teaching changed, as they stood at aegis-mcp-tools 684cac52. */
const IMAGE_TEACHING_PROMPTS_AT_684CAC52: Array<[string, () => ReturnType<typeof getZaruInit>, number, string]> = [
  ["agentic", () => getZaruInit("agentic"), 13654, "fe81838b1bf45fde5c0837b47b027a6f6d9dd28b9abf9d4a00251a121569ec80"],
  ["agentic+chat-uploads", () => getZaruInit("agentic", new Set(["chat-uploads"])), 17464, "da52e631c96f879162eb07c2d34fe40897753ac56c9d96716d1735ef977c073b"],
  ["execute", () => getZaruInit("execute"), 11628, "51f8fb63d247f277a04c96c07c654dd70a578fbce737bd50f9848ae559c2ea5b"],
];

/** The chat prompt at aegis-mcp-tools 684cac52; the pin table above holds no chat entry. */
const CHAT_PROMPT_AT_684CAC52: [number, string] = [9682, "b53354a10050c459eec7590315ea83ae4842a50964f5257f0542bd89d95e9a75"];

test("W52: the agentic and execute prompts teach aegis.image.generate in one paragraph, once, right after the aegis.execution.file entry of their TOOL KNOWLEDGE; no other mode's prompt holds the paragraph or names the tool", () => {
  const failures: string[] = [];
  const modes: Array<[string, ReturnType<typeof getZaruInit>]> = [
    ...ALL_MODES,
    ["agentic+chat-uploads", getZaruInit("agentic", new Set(["chat-uploads"]))],
  ];
  for (const [mode, init] of modes) {
    const prompt = init!.system_prompt;
    const count = prompt.split(IMAGE_TEACHING).length - 1;
    if (mode === "agentic" || mode === "agentic+chat-uploads" || mode === "execute") {
      if (count !== 1) {
        failures.push(`the ${mode} prompt holds the image teaching ${count} times, not once`);
        continue;
      }
      const knowledge = prompt.indexOf("\n## TOOL KNOWLEDGE\n");
      const at = prompt.indexOf(IMAGE_TEACHING);
      if (knowledge === -1 || at < knowledge) failures.push(`the ${mode} prompt's image teaching is not under its TOOL KNOWLEDGE`);
      else if (!prompt.includes(`${EXECUTION_FILE_KNOWLEDGE}\n${IMAGE_TEACHING}\n`))
        failures.push(`the ${mode} prompt's image teaching is not its own line right after the aegis.execution.file entry`);
      if (prompt.replace(IMAGE_TEACHING, "").replace(IMAGE_REQUEST_EXCEPTION, "").includes(IMAGE_GENERATE))
        failures.push(`the ${mode} prompt names ${IMAGE_GENERATE} outside its teaching and the image exception`);
    } else {
      if (count !== 0) failures.push(`the ${mode} prompt holds the image teaching`);
      if (prompt.includes(IMAGE_GENERATE)) failures.push(`the ${mode} prompt names ${IMAGE_GENERATE}`);
    }
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("W52: the agentic and execute tool lists hold aegis.image.generate once, right after aegis.execution.file; no other mode's list holds it", () => {
  const failures: string[] = [];
  for (const [mode, init] of ALL_MODES) {
    const tools = init!.available_tools;
    const count = tools.filter((tool) => tool === IMAGE_GENERATE).length;
    if (mode === "agentic" || mode === "execute") {
      if (count !== 1) failures.push(`the ${mode} list holds ${IMAGE_GENERATE} ${count} times, not once`);
      else if (tools[tools.indexOf(IMAGE_GENERATE) - 1] !== "aegis.execution.file")
        failures.push(`the ${mode} list does not hold ${IMAGE_GENERATE} right after aegis.execution.file`);
    } else if (count !== 0) {
      failures.push(`the ${mode} list holds ${IMAGE_GENERATE}`);
    }
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("W52: every other mode's prompt is unchanged byte for byte, and the agentic and execute prompts are their prompts at 684cac52 with only the image teaching's line and the image exception added", () => {
  const failures: string[] = [];
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const chat = withoutConnectionNeeds(getZaruInit("chat")!.system_prompt); // connection-needs-server: D3 (b)'s teaching taken out for the history pins
  if (chat.length !== CHAT_PROMPT_AT_684CAC52[0] || digest(chat) !== CHAT_PROMPT_AT_684CAC52[1])
    failures.push("the 'chat' prompt changed");
  const changed = new Set(IMAGE_TEACHING_PROMPTS_AT_684CAC52.map(([name]) => name));
  for (const [name, init, length, sha256] of UNCHANGED_PROMPTS) {
    if (changed.has(name)) continue;
    const prompt = init()!.system_prompt;
    if (prompt.length !== length || digest(prompt) !== sha256) failures.push(`the '${name}' prompt changed`);
  }
  for (const [name, init, length, sha256] of IMAGE_TEACHING_PROMPTS_AT_684CAC52) {
    const prompt = withoutConnectionNeeds(init()!.system_prompt);
    const line = `\n${IMAGE_TEACHING}`;
    if (!prompt.includes(line)) {
      failures.push(`the '${name}' prompt lacks the image teaching's line`);
      continue;
    }
    const before = stripWorkflowTeachings(prompt.replace(line, "").replace(`${IMAGE_REQUEST_EXCEPTION}\n\n`, "").replace(`\n${TRANSCRIBE_TEACHING}`, ""));
    if (before.length !== length || digest(before) !== sha256)
      failures.push(`the '${name}' prompt without the image teaching's line and the image exception is not its prompt at 684cac52`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

// ---------------------------------------------------------------------------
// AEGIS ADR-143 T8, second leg: in conversation ed6ade36 of 2026-10-11 Zaru,
// asked for an image in agentic mode, followed the rule that every request for
// a result is a task for one of its 100monkeys and called aegis.agent.generate
// nine times while its texts announced aegis.image.generate; the TOOL
// KNOWLEDGE line below the rule did not win. The image case is now an exception
// stated before each mode's mandatory sequence, and the TOOL KNOWLEDGE line is
// shortened to the tool's arguments and its refusal.
// ---------------------------------------------------------------------------

/** The prompts T8's second leg changed, as they stood at aegis-mcp-tools 13a3cb5d. */
const IMAGE_EXCEPTION_PROMPTS_AT_13A3CB5D: Array<[string, () => ReturnType<typeof getZaruInit>, number, string, string]> = [
  ["agentic", () => getZaruInit("agentic"), 14282, "e97b4b33799d892c609038ce0051df643db1e3743423439f6f5084140fe7822c", "\n## MANDATORY SEQUENCE FOR ALL TASKS\n"],
  ["agentic+chat-uploads", () => getZaruInit("agentic", new Set(["chat-uploads"])), 18092, "fb64811d31e4a387219254176048a8f471dfa4ecc34e93f734a7a4d7fcffdbb7", "\n## MANDATORY SEQUENCE FOR ALL TASKS\n"],
  ["execute", () => getZaruInit("execute"), 12256, "ba7e5cbe6d7238ccee2431da4d08ee44220f162116f8064bacfef3337646f0c6", "\n## MANDATORY SEQUENCE\n"],
];

test("W53: the agentic and execute prompts hold the image exception once, as its own paragraph, before their mandatory sequence's heading; no other mode's prompt holds it", () => {
  const failures: string[] = [];
  const headings = new Map(IMAGE_EXCEPTION_PROMPTS_AT_13A3CB5D.map(([name, init, , , heading]) => [name, [init()!.system_prompt, heading] as const]));
  for (const [name, [prompt, heading]] of headings) {
    const count = prompt.split(IMAGE_REQUEST_EXCEPTION).length - 1;
    if (count !== 1) {
      failures.push(`the ${name} prompt holds the image exception ${count} times, not once`);
      continue;
    }
    const at = prompt.indexOf(IMAGE_REQUEST_EXCEPTION);
    const sequence = prompt.indexOf(heading);
    const conversation = prompt.indexOf("\n# IN THIS CONVERSATION\n");
    if (sequence === -1) failures.push(`the ${name} prompt has no mandatory sequence heading`);
    else if (at > sequence) failures.push(`the ${name} prompt's image exception (at ${at}) is after its mandatory sequence's heading (at ${sequence})`);
    if (conversation === -1 || at < conversation) failures.push(`the ${name} prompt's image exception is not under IN THIS CONVERSATION`);
    if (!prompt.includes(`\n\n${IMAGE_REQUEST_EXCEPTION}\n\n`)) failures.push(`the ${name} prompt's image exception is not its own paragraph`);
  }
  for (const [mode, init] of ALL_MODES) {
    if (mode === "agentic" || mode === "execute") continue;
    if (init!.system_prompt.includes(IMAGE_REQUEST_EXCEPTION)) failures.push(`the ${mode} prompt holds the image exception`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("W54: the image exception makes aegis.image.generate its one act and names aegis.agent.generate, aegis.task.execute and aegis.workflow.run as never the call for an image", () => {
  const failures: string[] = [];
  for (const [name, init] of IMAGE_EXCEPTION_PROMPTS_AT_13A3CB5D) {
    const prompt = init()!.system_prompt;
    const at = prompt.indexOf(IMAGE_REQUEST_EXCEPTION);
    if (at === -1) {
      failures.push(`the ${name} prompt holds no image exception`);
      continue;
    }
    const exception = prompt.slice(at, at + IMAGE_REQUEST_EXCEPTION.length);
    if (!exception.includes(`Its one act is the tool call ${IMAGE_GENERATE}`)) failures.push(`the ${name} exception does not make ${IMAGE_GENERATE} its one act`);
    if (!/aegis\.agent\.generate, aegis\.task\.execute and aegis\.workflow\.run are never the call for an image/.test(exception))
      failures.push(`the ${name} exception does not name aegis.agent.generate, aegis.task.execute and aegis.workflow.run as never the call`);
    if (!/starts no agent, no workflow and no goal/.test(exception)) failures.push(`the ${name} exception does not say an image starts no agent, workflow or goal`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("W55: the agentic and execute prompts are their prompts at 13a3cb5d with only the image exception added and the image TOOL KNOWLEDGE line shortened; every other mode's prompt is unchanged byte for byte", () => {
  const failures: string[] = [];
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const chat = withoutConnectionNeeds(getZaruInit("chat")!.system_prompt); // connection-needs-server: D3 (b)'s teaching taken out for the history pins
  if (chat.length !== CHAT_PROMPT_AT_684CAC52[0] || digest(chat) !== CHAT_PROMPT_AT_684CAC52[1]) failures.push("the 'chat' prompt changed");
  const changed = new Set(IMAGE_EXCEPTION_PROMPTS_AT_13A3CB5D.map(([name]) => name));
  for (const [name, init, length, sha256] of UNCHANGED_PROMPTS) {
    if (changed.has(name)) continue;
    const prompt = init()!.system_prompt;
    if (prompt.length !== length || digest(prompt) !== sha256) failures.push(`the '${name}' prompt changed`);
  }
  for (const [name, init, length, sha256] of IMAGE_EXCEPTION_PROMPTS_AT_13A3CB5D) {
    const prompt = withoutConnectionNeeds(init()!.system_prompt);
    if (prompt.includes(IMAGE_TEACHING_AT_13A3CB5D)) failures.push(`the '${name}' prompt still holds the image line of 13a3cb5d`);
    if (!prompt.includes(`\n${IMAGE_TEACHING}\n`) || !prompt.includes(`${IMAGE_REQUEST_EXCEPTION}\n\n`)) {
      failures.push(`the '${name}' prompt lacks the shortened image line or the image exception`);
      continue;
    }
    // failed-run-told-once: the transcription line is removed before the strip, which would otherwise restore its earlier form.
    const before = stripWorkflowTeachings(prompt.replace(`\n${TRANSCRIBE_TEACHING}`, ""))
      .replace(`${IMAGE_REQUEST_EXCEPTION}\n\n`, "")
      .replace(`\n${IMAGE_TEACHING}\n`, `\n${IMAGE_TEACHING_AT_13A3CB5D}\n`);
    if (before.length !== length || digest(before) !== sha256) failures.push(`the '${name}' prompt, the exception removed and the line restored, is not its prompt at 13a3cb5d`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

// ---------------------------------------------------------------------------
// AEGIS ADR-143 S5 (under CORRECTION transcribe-audio-teaching-C1): the
// companion's teaching gains the record's sentence for an attached recording,
// byte for byte, and one sentence naming the run: aegis.workflow.run with
// `name` `transcribe-audio`, the attachment carried by the chat,
// `input.audio_path` the attached file's name, the transcript read from
// aegis.workflow.wait's answer (the step's stdout). It is taught in the agentic
// prompt's TOOL KNOWLEDGE alone, right after the aegis.image.generate line: the
// agentic mode is the one whose tool list offers aegis.workflow.run and
// aegis.workflow.wait beside the chat's attachments; execute offers neither.
// ---------------------------------------------------------------------------

/** The transcription line's first sentence: S5's, as Zaru ADR-0026's Update of 2026-10-15 (D3c) gives it since failed-run-told-once. */
const TRANSCRIBE_SENTENCE = "To turn an attached recording into text, run the workflow transcribe-audio with it.";

/**
 * The agentic TOOL KNOWLEDGE line since failed-run-told-once: D3c's three
 * sentences (no aegis.workflow.wait within the turn; the no-promise sentence
 * at its end), with the run it names and AEGIS ADR-143 S7c's teaching between
 * its first and its second. Until then the line was S5's sentence, the run,
 * `input.audio_path` the attached file's name and the transcript read from
 * aegis.workflow.wait's answer (the step's stdout).
 */
const TRANSCRIBE_TEACHING = `- ${TRANSCRIBE_SENTENCE} The run is aegis.workflow.run with \`name\` \`transcribe-audio\`, and the chat carries the attachment to the run. \`input.audio_path\` may be left out when one file is attached; otherwise it is the file's name exactly as the chat's attachment marker gives it. The transcript is the run's answer, which reaches the person on the card above. Tell the person the run has started and end your turn; your turn ends there and nothing of yours watches the run after it: promise nothing for after your turn.`;

/** The prompts S5's teaching changed, as they stood at aegis-mcp-tools 68df01fc. */
const TRANSCRIBE_PROMPTS_AT_68DF01FC: Array<[string, () => ReturnType<typeof getZaruInit>, number, string]> = [
  ["agentic", () => getZaruInit("agentic"), 14724, "218f9cd778b5ff1fa4c9cf588543cf8fce8aa27be141dcdfbdaf5a2d60e33890"],
  ["agentic+chat-uploads", () => getZaruInit("agentic", new Set(["chat-uploads"])), 18534, "f73441881fa5f939c4542df72d158da14e0bc7f30844703061bbd55bc3eaa925"],
];

test("W56: the agentic prompt teaches transcribe-audio once, as its own TOOL KNOWLEDGE line right after the aegis.image.generate line; no other mode's prompt holds S5's sentence", () => {
  const failures: string[] = [];
  const modes: Array<[string, ReturnType<typeof getZaruInit>]> = [
    ...ALL_MODES,
    ["agentic+chat-uploads", getZaruInit("agentic", new Set(["chat-uploads"]))],
    ["workflow+chat-uploads", getZaruInit("workflow", new Set(["chat-uploads"]))],
    ["execute+chat-uploads", getZaruInit("execute", new Set(["chat-uploads"]))],
  ];
  for (const [mode, init] of modes) {
    const prompt = init!.system_prompt;
    const count = prompt.split(TRANSCRIBE_SENTENCE).length - 1;
    if (mode === "agentic" || mode === "agentic+chat-uploads") {
      if (count !== 1) {
        failures.push(`the ${mode} prompt holds S5's sentence ${count} times, not once`);
        continue;
      }
      const knowledge = prompt.indexOf("\n## TOOL KNOWLEDGE\n");
      const at = prompt.indexOf(TRANSCRIBE_SENTENCE);
      if (knowledge === -1 || at < knowledge) failures.push(`the ${mode} prompt's transcribe-audio teaching is not under its TOOL KNOWLEDGE`);
      else if (!prompt.includes(`\n${IMAGE_TEACHING}\n${TRANSCRIBE_TEACHING}\n`))
        failures.push(`the ${mode} prompt's transcribe-audio teaching is not its own line right after the aegis.image.generate line`);
    } else if (count !== 0 || prompt.includes("transcribe-audio")) {
      failures.push(`the ${mode} prompt holds S5's sentence or names transcribe-audio`);
    }
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("W57: the agentic prompts are their prompts at 68df01fc with only the transcribe-audio line added; every other mode's prompt is unchanged byte for byte, and the tool lists still offer aegis.workflow.run and aegis.workflow.wait in agentic and not in execute", () => {
  const failures: string[] = [];
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const chat = withoutConnectionNeeds(getZaruInit("chat")!.system_prompt); // connection-needs-server: D3 (b)'s teaching taken out for the history pins
  if (chat.length !== CHAT_PROMPT_AT_684CAC52[0] || digest(chat) !== CHAT_PROMPT_AT_684CAC52[1]) failures.push("the 'chat' prompt changed");
  const changed = new Set(TRANSCRIBE_PROMPTS_AT_68DF01FC.map(([name]) => name));
  for (const [name, init, length, sha256] of UNCHANGED_PROMPTS) {
    if (changed.has(name)) continue;
    const prompt = init()!.system_prompt;
    if (prompt.length !== length || digest(prompt) !== sha256) failures.push(`the '${name}' prompt changed`);
  }
  for (const [name, init, length, sha256] of TRANSCRIBE_PROMPTS_AT_68DF01FC) {
    const prompt = withoutConnectionNeeds(init()!.system_prompt);
    const line = `\n${TRANSCRIBE_TEACHING}`;
    if (!prompt.includes(line)) {
      failures.push(`the '${name}' prompt lacks the transcribe-audio line`);
      continue;
    }
    const before = stripWorkflowTeachings(prompt.replace(line, ""));
    if (before.length !== length || digest(before) !== sha256)
      failures.push(`the '${name}' prompt without the transcribe-audio line is not its prompt at 68df01fc`);
  }
  const agenticTools = getZaruInit("agentic")!.available_tools;
  const executeTools = getZaruInit("execute")!.available_tools;
  for (const tool of ["aegis.workflow.run", "aegis.workflow.wait"]) {
    if (!agenticTools.includes(tool)) failures.push(`the agentic list lacks ${tool}`);
    if (executeTools.includes(tool)) failures.push(`the execute list holds ${tool}`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

// ---------------------------------------------------------------------------
// AEGIS ADR-141's Update "Human gates approved through the MCP surface" and
// ADR-055's Update "A workflow manifest deployed from the MCP surface"
// (2026-10-12), the Zaru MCP server's half, in the workflow mode on Jeshua's
// word of 2026-10-12 ("There's a workflow mode, aside from agentic and chat"):
// the workflow mode's tool list carries aegis.workflow.signal and holds
// aegis.workflow.create and aegis.workflow.update right after it, and its
// prompt ends with a TOOL KNOWLEDGE block of one line for each, the lines
// aegis-mcp-tools c3706b92 put in the agentic prompt, unchanged. The agentic
// mode lists and teaches none of the three, its prompt its prompt at 3e3ff265
// again. The argument names and the quoted refusals are the orchestrator's
// handlers' at aegis-orchestrator 7523ee0a (tool_invocation_service/workflows.rs:
// signal 879-965, update 1338-1460, create 1462-1730). The operator mode's list
// already carries the tools and does not change; no other mode lists or names
// them.
// ---------------------------------------------------------------------------

const WORKFLOW_TOOLS_ADDED = ["aegis.workflow.signal", "aegis.workflow.create", "aegis.workflow.update"];

/** The signal line as it stood at aegis-mcp-tools 4791cab1, before the gate-conduct rules. */
const SIGNAL_TEACHING_AT_4791CAB1 =
  "- `aegis.workflow.signal`: Answer a run's Human gate with the person's own answer. Takes `execution_id`, the person's `response` and, optionally, their `feedback`. Call it only after the person has answered the gate they were shown. The answer's `signalled` is true when the run received the answer; otherwise say its `error` sentence, such as \"Workflow execution '<id>' not found\". Never say a gate was approved without this tool's answer.";

const CREATE_TEACHING =
  "- `aegis.workflow.create`: Deploy a workflow manifest the person gives you. Takes `manifest_yaml`, their manifest as they gave it. The answer's `deployed` is true when the workflow was deployed; otherwise say why in the answer's own words, such as \"Workflow parser validation failed: …\", \"Workflow cycle validation failed: …\" or \"Workflow '<name>' version '<version>' is already registered. Increment the version (e.g. to '<version>.1') in the manifest and retry.\" Never say a workflow was deployed without this tool's answer.";

const UPDATE_TEACHING =
  "- `aegis.workflow.update`: Replace a deployed workflow with a manifest of the same name the person gives you. Takes `manifest_yaml` and, optionally, `force` set to true to overwrite the same version. The answer's `updated` is true when the workflow was replaced; otherwise say its `error` sentence, such as \"Workflow not found\" or \"Workflow update failed: …\". Never say a workflow was updated without this tool's answer.";

/** The signal line at f332aa9c: its teaching at 4791cab1 with the gate-conduct rule (GC1, GATE_RULE_SENTENCES) in place of "Call it only after the person has answered the gate they were shown." */
const SIGNAL_TEACHING_AT_F332AA9C =
  "- `aegis.workflow.signal`: Answer a run's Human gate with the person's own answer. Takes `execution_id`, the person's `response` and, optionally, their `feedback`. A Human gate is the person's, never yours: you never answer it for them, and you never carry an answer forward from what they said before the gate was shown; a sentence such as \"test the workflow end to end\" is not an answer to a gate. Call it only in a turn whose message from the person answers the gate you showed them, and only once for that gate. Its `response` is the word the gate's prompt names, `yes` or `no`, exactly, never another word such as \"approved\"; the person's reasons go in `feedback`, in their own words, never a paraphrase. When their reply is not plainly yes or no, ask them which it is and do not call it. The answer's `signalled` is true when the run received the answer; otherwise say its `error` sentence, such as \"Workflow execution '<id>' not found\". Never say a gate was approved without this tool's answer.";

/** Gate fidelity, rule 3: the signal carries the run's own id (GF2). */
const SIGNAL_ID_SENTENCE = "Its `execution_id` is always the one aegis.workflow.run answered for that run.";
/** Gate fidelity, rule 1: after the signal, the state is read, never told (GF2). */
const SIGNAL_AFTER_SENTENCE =
  "After it answers, call aegis.workflow.wait or aegis.workflow.logs with that `execution_id` and report the state their answer gives; until one of them has answered, say you have not read the run's state yet.";

/** A signal line with the two gate-fidelity sentences put in: the id after the arguments, the read after the answer's error sentence. */
const withSignalFidelity = (line: string) =>
  line
    .replace("their `feedback`. ", `their \`feedback\`. ${SIGNAL_ID_SENTENCE} `)
    .replace(" Never say a gate was approved", ` ${SIGNAL_AFTER_SENTENCE} Never say a gate was approved`);

/** The signal line now: its line at f332aa9c with the gate-fidelity sentences (GF2). */
const SIGNAL_TEACHING = withSignalFidelity(SIGNAL_TEACHING_AT_F332AA9C);

// The signal line left the workflow prompt on 2026-10-13 (the signal-removal
// tests at the end of this file); create follows the wait line.
const WORKFLOW_TEACHINGS: Array<[string, string]> = [
  ["aegis.workflow.create", CREATE_TEACHING],
  ["aegis.workflow.update", UPDATE_TEACHING],
];

/** The agentic prompts as they stood at aegis-mcp-tools 3e3ff265, before the three lines, and stand again. */
const WORKFLOW_TEACHING_PROMPTS_AT_3E3FF265: Array<[string, () => ReturnType<typeof getZaruInit>, number, string]> = [
  ["agentic", () => getZaruInit("agentic"), 15074, "529d4c5becefa4249b9d466788f3aa42306cf59f757e954971bac5bd9fe4e3d1"],
  ["agentic+chat-uploads", () => getZaruInit("agentic", new Set(["chat-uploads"])), 18884, "55a9909fd474937d4c0c2236af20eaaac228db2abf16df93391fcccd7f31ef04"],
];

// The history tests below compare a prompt with its pinned past: the
// gate-conduct lines are removed first (stripGateConduct, at the end of this file).
const stripWorkflowTeachings = (prompt: string) =>
  stripGateConduct(prompt).replace(`\n${SIGNAL_TEACHING_AT_4791CAB1}`, "").replace(`\n${CREATE_TEACHING}`, "").replace(`\n${UPDATE_TEACHING}`, "");

/** The workflow prompts as they stood at aegis-mcp-tools c3706b92, before the TOOL KNOWLEDGE block. */
const WORKFLOW_PROMPTS_AT_C3706B92: Array<[string, () => ReturnType<typeof getZaruInit>, number, string]> = [
  ["workflow", () => getZaruInit("workflow"), 10150, "2ea17a05d6540a237445a62307ad627dc93088b9454f21f818d2570e106c3148"],
  ["workflow+chat-uploads", () => getZaruInit("workflow", new Set(["chat-uploads"])), 13960, "9a17347faff906e8bcc5916724273018a3e36d6ab52e7f59b94f476b5c8219df"],
];

const WORKFLOW_KNOWLEDGE_BLOCK = `\n## TOOL KNOWLEDGE\n\n${SIGNAL_TEACHING_AT_4791CAB1}\n${CREATE_TEACHING}\n${UPDATE_TEACHING}\n`;

const stripWorkflowKnowledge = (prompt: string) => stripGateConduct(prompt).replace(WORKFLOW_KNOWLEDGE_BLOCK, "");

test("WT1: the workflow tool list holds aegis.workflow.create and aegis.workflow.update once each, in that order, right after aegis.git.list, and no aegis.workflow.signal", () => {
  const tools = getZaruInit("workflow")!.available_tools;
  const held = WORKFLOW_TOOLS_ADDED.filter((t) => t !== "aegis.workflow.signal");
  for (const tool of held) {
    assert.equal(tools.filter((t) => t === tool).length, 1, `the workflow list holds ${tool} once`);
  }
  assert.equal(tools.includes("aegis.workflow.signal"), false, "the workflow list holds aegis.workflow.signal");
  const at = tools.indexOf("aegis.git.list");
  assert.deepEqual(tools.slice(at + 1, at + 1 + held.length), held);
});

test("WT1: the agentic tool list holds none of the three; the execute, chat, live, vibecode and operator tool lists hold them as they did at 3e3ff265, but for aegis.workflow.signal, which the operator list no longer holds", () => {
  const expected: Record<string, string[]> = {
    chat: [],
    agentic: [],
    execute: [],
    live: [],
    vibecode: [],
    operator: ["aegis.workflow.create", "aegis.workflow.update"],
  };
  const failures: string[] = [];
  for (const [mode, init] of ALL_MODES) {
    if (mode === "workflow") continue;
    const held = init!.available_tools.filter((t) => WORKFLOW_TOOLS_ADDED.includes(t));
    if (JSON.stringify(held) !== JSON.stringify(expected[mode])) failures.push(`the ${mode} list holds ${JSON.stringify(held)}`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

for (const [index, [tool, teaching]] of WORKFLOW_TEACHINGS.entries()) {
  test(`WT${index + 2}: the workflow prompt teaches ${tool} once, as its own line in order in its TOOL KNOWLEDGE block; the agentic prompt and every other mode's prompt hold the line 0 times`, () => {
    const failures: string[] = [];
    const modes: Array<[string, ReturnType<typeof getZaruInit>]> = [
      ...ALL_MODES,
      ["agentic+chat-uploads", getZaruInit("agentic", new Set(["chat-uploads"]))],
      ["workflow+chat-uploads", getZaruInit("workflow", new Set(["chat-uploads"]))],
      ["execute+chat-uploads", getZaruInit("execute", new Set(["chat-uploads"]))],
    ];
    const previous = index === 0 ? WORKFLOW_WAIT_TEACHING : WORKFLOW_TEACHINGS[index - 1][1];
    for (const [mode, init] of modes) {
      const prompt = init!.system_prompt;
      const count = prompt.split(teaching).length - 1;
      if (mode === "workflow" || mode === "workflow+chat-uploads") {
        if (count !== 1) {
          failures.push(`the ${mode} prompt holds the ${tool} line ${count} times, not once`);
          continue;
        }
        const knowledge = prompt.indexOf("\n## TOOL KNOWLEDGE\n");
        if (knowledge === -1 || prompt.indexOf(teaching) < knowledge) failures.push(`the ${mode} prompt's ${tool} line is not under its TOOL KNOWLEDGE`);
        else if (!prompt.includes(`\n${previous}\n${teaching}\n`))
          failures.push(`the ${mode} prompt's ${tool} line is not its own line right after the line before it`);
      } else if (count !== 0) {
        failures.push(`the ${mode} prompt holds the ${tool} line ${count} times, not 0`);
      }
    }
    assert.deepEqual(failures, [], failures.join("; "));
  });
}

test("WT5: each teaching line names the tool's arguments as the orchestrator's handler reads them and never lets the model claim the act without the tool's answer", () => {
  const failures: string[] = [];
  const lines = getZaruInit("workflow")!.system_prompt.split("\n");
  const names: Array<[string, string[]]> = [
    ["aegis.workflow.create", ["`manifest_yaml`", "`deployed`"]],
    ["aegis.workflow.update", ["`manifest_yaml`", "`force`", "`updated`"]],
  ];
  for (const [tool, words] of names) {
    const line = lines.find((l) => l.startsWith(`- \`${tool}\`: `));
    if (line === undefined) {
      failures.push(`the workflow prompt has no TOOL KNOWLEDGE line for ${tool}`);
      continue;
    }
    for (const word of words) if (!line.includes(word)) failures.push(`the ${tool} line does not name ${word}`);
    if (!/Never say .* without this tool's answer\.$/.test(line)) failures.push(`the ${tool} line does not end on the never-claim sentence`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("WT6: with the gate-conduct lines removed, the agentic prompts are their prompts at 3e3ff265, the workflow prompts their prompts at c3706b92 with only the TOOL KNOWLEDGE block of the three lines added; every other mode's prompt is unchanged byte for byte", () => {
  const failures: string[] = [];
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const chat = withoutConnectionNeeds(getZaruInit("chat")!.system_prompt); // connection-needs-server: D3 (b)'s teaching taken out for the history pins
  if (chat.length !== CHAT_PROMPT_AT_684CAC52[0] || digest(chat) !== CHAT_PROMPT_AT_684CAC52[1]) failures.push("the 'chat' prompt changed");
  const changed = new Set(WORKFLOW_PROMPTS_AT_C3706B92.map(([name]) => name));
  for (const [name, init, length, sha256] of UNCHANGED_PROMPTS) {
    if (changed.has(name)) continue;
    const prompt = init()!.system_prompt;
    if (prompt.length !== length || digest(prompt) !== sha256) failures.push(`the '${name}' prompt changed`);
  }
  for (const [name, init, length, sha256] of WORKFLOW_TEACHING_PROMPTS_AT_3E3FF265) {
    const prompt = stripGateConduct(withoutConnectionNeeds(init()!.system_prompt));
    if (prompt.length !== length || digest(prompt) !== sha256) failures.push(`the '${name}' prompt is not its prompt at 3e3ff265`);
  }
  for (const [name, init, length, sha256] of WORKFLOW_PROMPTS_AT_C3706B92) {
    const prompt = stripGateConduct(withoutConnectionNeeds(init()!.system_prompt));
    if (prompt.split(WORKFLOW_KNOWLEDGE_BLOCK).length !== 2) {
      failures.push(`the '${name}' prompt does not hold the TOOL KNOWLEDGE block of the three lines once`);
      continue;
    }
    const before = stripWorkflowKnowledge(prompt);
    if (before.length !== length || digest(before) !== sha256)
      failures.push(`the '${name}' prompt without the TOOL KNOWLEDGE block is not its prompt at c3706b92`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

// ---------------------------------------------------------------------------
// Gate conduct (AEGIS ADR-141's Update "Human gates approved through the MCP
// surface", Zaru ADR-0026's Update of 2026-10-12; Jeshua, 2026-10-12: "Zaru is
// the interface, it doesn't really "autonomously decide" outside of its
// interactions with the user (me)"). On the Forge run 9f279438 Zaru, in the
// workflow mode, approved the requirements gate itself ("I'm carrying your yes
// forward"), answered the design gate with `response: "approved"` where the
// gate's prompt says "Answer yes … or no …" (aegis-orchestrator de9acea3
// cli/templates/workflows/the-forge.yaml 119, 170; any other word ends the
// run), then started a second run 7fc882af unasked, not draft only by its own
// choice. Three rules, each a sentence asserted below: (1) a Human gate is the
// person's: shown whole, waited on, answered once with the word the gate's
// prompt names (`yes` or `no`) and the person's reasons in `feedback`; (2) one
// run for one request; (3) `draft_only` is the person's choice, asked for when
// the request does not say, and the value sent is stated. The workflow mode
// teaches all three on its TOOL KNOWLEDGE lines for aegis.workflow.run,
// aegis.workflow.wait and aegis.workflow.signal; the agentic mode, which offers
// aegis.workflow.run and aegis.workflow.wait and not the signal, teaches (2) and
// (3) on the same run line and (1) on its own wait line. These tests pin the
// text; whether the model obeys it is proved on the live page only.
// ---------------------------------------------------------------------------

/** Rule 1: the gate is the person's (the workflow mode's signal line). */
const GATE_RULE_SENTENCES = [
  "A Human gate is the person's, never yours: you never answer it for them, and you never carry an answer forward from what they said before the gate was shown; a sentence such as \"test the workflow end to end\" is not an answer to a gate.",
  "Call it only in a turn whose message from the person answers the gate you showed them, and only once for that gate.",
  "Its `response` is the word the gate's prompt names, `yes` or `no`, exactly, never another word such as \"approved\"; the person's reasons go in `feedback`, in their own words, never a paraphrase.",
  "When their reply is not plainly yes or no, ask them which it is and do not call it.",
];

/** The gate is the person's control (the run line, in both modes that offer the run). */
const GATE_CONTROL_SENTENCE =
  "A Human gate is the person's, answered by the person on their own control and never by you: you have no tool that answers a gate, and you never answer one for them or say one was answered unless a tool's answer shows it.";

/** The three places the person answers a gate, in Zaru Web's words. */
const GATE_PLACES = "the card under the run in this conversation, or Approvals, or the run's execution page";

/** The tools that read a run, per mode: the only ones whose answer says a gate was answered. */
const GATE_READERS: Record<string, string> = {
  workflow: "aegis.workflow.wait or aegis.workflow.logs",
  agentic: "aegis.workflow.wait",
};

/** The wait line's clause after the gate's prompt, per mode. */
const gatePlaceClause = (mode: string) =>
  `say that the run waits for their answer on their own control: ${GATE_PLACES}; never ask them for their answer in the chat, never say the gate was answered unless ${GATE_READERS[mode]} answers so, and end your turn.`;

/** Where the person answers, no answer asked for in the chat and none claimed without a tool's answer (each mode's wait line). */
const ON_CONTROL_CLAUSE = gatePlaceClause("workflow");
const AGENTIC_ON_CONTROL_CLAUSE = gatePlaceClause("agentic");

/** After the person says they answered: the state read, never told (the workflow mode's logs line). */
const LOGS_AFTER_SENTENCE =
  "When the person says they have answered a gate, read the run's state with this tool or aegis.workflow.wait and that `execution_id`, and report the state the tool answers; until one of them has answered, say you have not read the run's state yet.";

/** After the person says they answered, where the agentic mode offers the wait alone. */
const AGENTIC_AFTER_SENTENCE =
  "When the person says they have answered the gate, call aegis.workflow.wait again with that `execution_id` and report the state it answers; until it has answered, say you have not read the run's state yet.";

/** Rule 1: showing the gate and waiting (the workflow mode's wait line). */
const GATE_SHOWN_SENTENCES = [
  `When the run waits at a Human gate, read the gate's prompt from its \`HumanInputRequested\` event with aegis.workflow.logs and that \`execution_id\`, show the person that prompt whole, word for word, as the tool answered it, and ${ON_CONTROL_CLAUSE}`,
  "When the answer's status is `completed` while its current state is a Human gate, the run ended at that gate and did nothing after it: say so with its `execution_id` and the gate's name, never as a success.",
];

/** Rule 1 in the agentic mode's wait line. */
const AGENTIC_GATE_SENTENCES = [
  `When the run waits at a Human gate, show the person the gate's prompt whole, word for word, as the tool answered it, when the answer carries it, and ${AGENTIC_ON_CONTROL_CLAUSE}`,
  AGENTIC_AFTER_SENTENCE,
  "When the answer's status is `completed` while its current state is a Human gate, the run ended at that gate and did nothing after it: say so with its `execution_id` and the gate's name, never as a success.",
];

/** Rules 2 and 3 (the run line, the same in both modes that offer the run). */
const ONE_RUN_SENTENCES = [
  "Start one run for one request.",
  "Never start a second run of the same workflow unless the person asks for one after the first has ended.",
  "A run that failed, or ended at a gate, is reported with its `execution_id` and the gate or state it ended on; never start it again to put it right.",
];
const DRAFT_ONLY_SENTENCES = [
  "`draft_only` is the person's choice, never yours: when the workflow takes `draft_only` and their request does not say whether the run may land its change, ask them before you start it, and send the value they chose.",
  "Say in your reply the `draft_only` value you sent.",
];

const COMPLETED_AT_GATE = GATE_SHOWN_SENTENCES[1];

/** Gate fidelity, rule 2: the inputs are read before the run, from the tool of the mode's own list that answers them (GF4). */
const INPUTS_TOOL: Record<string, string> = { workflow: "aegis.workflow.list", agentic: "aegis.workflow.search" };
const inputsReadSentence = (tool: string) =>
  `Before you start it, read the workflow's inputs: the \`input_schema\` its entry carries in ${tool}'s answer names each input, and its \`required\` list the ones the run cannot start without.`;
const INPUTS_ASK_SENTENCE =
  "Ask the person for each required input their request does not give, such as `test_command` and `test_image`, and start the run only when `input` holds every one of them; never send a call you know is short.";

/** Gate fidelity, rule 1: what Zaru shows is read and quoted, never composed (GF1). */
const FIDELITY_SENTENCES = [
  "Every gate, state, verdict and progress sentence you show the person is read from a tool's answer, in this turn or an earlier one, and quoted, never composed.",
  "A gate is shown only as the prompt a tool answered for it, whole, the second and every later gate as much as the first: never shorten any part of it, as with \"as previously shown\", and never show a gate no tool answered.",
  "Never say a commit, push, test or landing happened, or that a run is at a state, unless a tool's answer says so.",
];

/** Gate fidelity, rule 3: the logs carry the run's own id (GF3). */
const LOGS_ID_SENTENCE =
  "Takes `execution_id`, always the one aegis.workflow.run answered for that run, on every call; a call without it is refused with \"required field 'execution_id' is missing or null\".";

/** After the run starts: say so, where it shows, and end the turn (the run line, both modes). */
const STARTED_RUN_SENTENCE =
  "When aegis.workflow.run answers `started`, tell the person the run has started, with its `execution_id`, that the card above shows its state, and that each Human gate appears on that card and in Approvals, the badge in the header, for them to answer there, never in the chat; then end your turn without calling aegis.workflow.wait.";

/** gate-promise-wording: no promise for after the turn; a later question is one read (the run line, both modes; GP1, GP2). */
const NO_PROMISE_SENTENCES = [
  "Your turn ends there and nothing of yours watches the run after it: never promise to bring a gate or its prompt into the chat later, to pass it on, show it or quote it when the run gets there, or to watch the run or come back to it; promise nothing for after your turn.",
  "When the person asks about the run later, read it once with aegis.workflow.wait and answer from that one read.",
];

/** At most one wait a turn, only when asked, never in a loop; running is one sentence (the wait line, both modes). */
const WAIT_ONCE_SENTENCES = [
  "Call aegis.workflow.wait at most once in a turn and never in a loop: only when the person asks what a run is doing now or what it produced, a run they ask about later included, or when the person says they have answered its gate.",
  "When its answer reads running, say so in one sentence and end your turn.",
];

/** Logs only for a gate's prompt, the run's history or an ended run (the workflow mode's logs line). */
const LOGS_WHEN_SENTENCES = [
  "Call aegis.workflow.logs at most once in a turn and never in a loop: only to read the prompt of the gate aegis.workflow.wait answered the run waits at, when the person asks for the run's history, when the person says they have answered its gate, or when the run has ended; never to see whether a run is still going.",
  "When its answer shows the run still running, say so in one sentence and end your turn.",
];

/** An agent or task wait that answers running: one sentence, the card named, the turn ended. */
const EXECUTION_RUNNING_SENTENCE =
  "Call it once in this turn and never in a loop: when it answers that the execution is still running, say so in one sentence with its `execution_id` and that the card above shows its state as it runs, and end your turn.";

/** card-above-wording: the workflow run line's no-promise sentence, carried verbatim onto the agentic run line (Step 3) and the workflow test-execution line (Step 5), after the running sentence (CA2, CA3). */
const EXECUTION_NO_PROMISE_SENTENCE = NO_PROMISE_SENTENCES[0];

/** The same, where the card's live state is not read for every wait the step names (the workflow mode's Step 3). */
const GENERATE_RUNNING_SENTENCE =
  "Call it once in this turn and never in a loop: when it answers that the execution is still running, say so in one sentence with its `execution_id` and end your turn.";

/** Agentic Step 1, a matching workflow: started, the turn ended, the result when asked; since failed-run-told-once, the no-promise sentence at its end (Zaru ADR-0026 D3c). */
const AGENTIC_STEP1_WORKFLOW = `If a matching workflow exists, run it with aegis.workflow.run, tell the person it has started and end your turn without calling aegis.workflow.wait, as its TOOL KNOWLEDGE line says; Step 4 reports its result when the person asks for it. ${NO_PROMISE_SENTENCES[0]}`;

/** The agentic and workflow Steps' text before the run-then-yield sentences (the history tests compare against it). */
const STEPS_BEFORE_RUN_THEN_YIELD: Array<[string, string]> = [
  [AGENTIC_STEP1_WORKFLOW, "If a matching workflow exists, run it with aegis.workflow.run, call aegis.workflow.wait with the execution_id it returns, then go to Step 4."],
  [
    `You MUST then immediately call aegis.task.wait with that execution_id; it waits server-side for the execution. Do NOT respond to the user before it answers, and do NOT say "I'll let you know when it's ready". ${EXECUTION_RUNNING_SENTENCE} ${EXECUTION_NO_PROMISE_SENTENCE} `,
    `You MUST then immediately call aegis.task.wait with that execution_id. aegis.task.wait blocks server-side until the execution finishes. Call it once and wait. Do NOT respond to the user, do NOT say "I'll let you know when it's ready", do NOT say "it's in progress" — just call aegis.task.wait and wait for it to return. `,
  ],
  [`do not proceed until it returns. ${EXECUTION_RUNNING_SENTENCE} `, "do not proceed until it returns. "],
  [`until the wait tool returns. ${GENERATE_RUNNING_SENTENCE} `, "until the wait tool returns. "],
  [`with the returned execution_id. ${EXECUTION_RUNNING_SENTENCE} ${EXECUTION_NO_PROMISE_SENTENCE} `, "with the returned execution_id. "],
  // run-then-yield-C2: the execute and operator lines (RY6).
  [
    "say in one sentence that it is still running, with its `execution_id`, and end your turn; call aegis.execute.wait again only when the person asks, never in a loop. Do NOT fall back",
    "call aegis.execute.wait AGAIN with the same execution_id. Keep calling aegis.execute.wait until you get a terminal status (\"completed\" or \"failed\"). Do NOT fall back",
  ],
  [
    "returns before the workflow finishes, say in one sentence that it is still running, with its `execution_id`, and end your turn; read it again only when the person asks, never in a loop.",
    "returns before the workflow finishes, check the status and wait again if it's still running.",
  ],
];

/** A prompt with the run-then-yield sentences of its Steps taken out, as it stood at 2d29b3b1 outside its TOOL KNOWLEDGE. */
/** failed-run-told-once (Zaru ADR-0026 D3b): the rule, as each mode holds it: a paragraph after the agentic Goal check paragraph and after the workflow Step 6, the last bullet of the operator's failures list. */
const FAILED_RUN_TOLD_ONCE_TEXT =
  "shows that a run you started failed, tell the person in one sentence that it failed, carrying the run's own failure sentence: the `feedback` of the transition it failed on where the run gives one, otherwise the state it failed in and the first line of that state's error. End your turn at that sentence: do not search, verify, retry or start the run again unless the person asks.";
const FAILED_RUN_TOLD_ONCE_INSERTS = [
  `\n\nWhen aegis.workflow.wait's or aegis.task.wait's answer, or a Goal check, ${FAILED_RUN_TOLD_ONCE_TEXT}`,
  `\n\nWhen aegis.workflow.wait's or aegis.task.wait's answer ${FAILED_RUN_TOLD_ONCE_TEXT}`,
  `\n- When aegis.workflow.wait's or aegis.task.wait's answer ${FAILED_RUN_TOLD_ONCE_TEXT}`,
];

/** The transcription line as it stood from aegis-mcp-tools 68df01fc until failed-run-told-once (the history pins after 68df01fc hold it). */
const TRANSCRIBE_TEACHING_BEFORE_FAILED_RUN =
  "- To turn an attached recording into text, run the workflow transcribe-audio with it; the transcript is its answer. The run is aegis.workflow.run with `name` `transcribe-audio` and `input.audio_path` set to the attached file's name; the chat carries the attachment to the run, and the transcript is the step's stdout in aegis.workflow.wait's answer.";

const stripRunThenYieldSteps = (prompt: string) =>
  STEPS_BEFORE_RUN_THEN_YIELD.reduce(
    (text, [now, before]) => text.replace(now, before),
    FAILED_RUN_TOLD_ONCE_INSERTS.reduce((text, insert) => text.replace(insert, ""), prompt).replace(
      `\n${TRANSCRIBE_TEACHING}\n`,
      `\n${TRANSCRIBE_TEACHING_BEFORE_FAILED_RUN}\n`,
    ),
  );

/** run-then-yield-C1: `task` is the person's own words (the run line, both modes; RY5). */
const TASK_WORDS_SENTENCE =
  "Every required input is filled, and `task` is the person's request in their own words, as they wrote it: never a paraphrase, never a task you composed, and never left out.";

const RUN_HEAD = "- `aegis.workflow.run`: Start a run of a workflow. Takes `name`, `input` and, for a workflow that works on a repository, `repositories`.";

/** The run line at f332aa9c, the same in the workflow and agentic modes. */
const RUN_TEACHING_AT_F332AA9C = `${RUN_HEAD} ${[...ONE_RUN_SENTENCES, ...DRAFT_ONLY_SENTENCES].join(" ")}`;

/** The run line now: the inputs sentences after the arguments, naming the mode's own tool. */
const runTeaching = (tool: string) => `${RUN_HEAD} ${inputsReadSentence(tool)} ${INPUTS_ASK_SENTENCE} ${TASK_WORDS_SENTENCE} ${[...ONE_RUN_SENTENCES, ...DRAFT_ONLY_SENTENCES, GATE_CONTROL_SENTENCE, STARTED_RUN_SENTENCE, ...NO_PROMISE_SENTENCES].join(" ")}`;
const WORKFLOW_RUN_TEACHING = runTeaching(INPUTS_TOOL.workflow);
/** The agentic run line since failed-run-told-once (Zaru ADR-0026 D3c): the later-read sentence before the started-run sentence, so the line ends with the no-promise sentence. */
const AGENTIC_RUN_TEACHING = `${RUN_HEAD} ${inputsReadSentence(INPUTS_TOOL.agentic)} ${INPUTS_ASK_SENTENCE} ${TASK_WORDS_SENTENCE} ${[...ONE_RUN_SENTENCES, ...DRAFT_ONLY_SENTENCES, GATE_CONTROL_SENTENCE, NO_PROMISE_SENTENCES[1], STARTED_RUN_SENTENCE, NO_PROMISE_SENTENCES[0]].join(" ")}`;

/** The workflow mode's wait line. */
const WORKFLOW_WAIT_TEACHING = `- \`aegis.workflow.wait\`: Wait for a run you started. Takes its \`execution_id\`. ${WAIT_ONCE_SENTENCES.join(" ")} ${GATE_SHOWN_SENTENCES.join(" ")} ${FIDELITY_SENTENCES.join(" ")}`;

/** The agentic mode's wait line. */
const AGENTIC_WAIT_TEACHING = `- \`aegis.workflow.wait\`: Wait for a run you started. Takes its \`execution_id\`. ${WAIT_ONCE_SENTENCES.join(" ")} ${AGENTIC_GATE_SENTENCES.join(" ")} ${FIDELITY_SENTENCES.join(" ")}`;

/** The workflow mode's logs line, the last of its TOOL KNOWLEDGE. */
const WORKFLOW_LOGS_TEACHING = `- \`aegis.workflow.logs\`: Read a run's events, among them each gate's \`HumanInputRequested\` event with its \`prompt\`. ${LOGS_ID_SENTENCE} ${LOGS_WHEN_SENTENCES.join(" ")} ${LOGS_AFTER_SENTENCE} Never say what a run did without this tool's or aegis.workflow.wait's answer.`;

/** A prompt with the gate-conduct lines removed and the signal line put back as it stood at 4791cab1, the first line of the workflow prompt's TOOL KNOWLEDGE before create: the history tests compare this with their pins. */
const stripGateConduct = (prompt: string) =>
  stripRunThenYieldSteps(prompt)
    .replace(`\n${WORKFLOW_RUN_TEACHING}`, "")
    .replace(`\n${AGENTIC_RUN_TEACHING}`, "")
    .replace(`\n${WORKFLOW_WAIT_TEACHING}`, "")
    .replace(`\n${AGENTIC_WAIT_TEACHING}`, "")
    .replace(`\n${WORKFLOW_LOGS_TEACHING}`, "")
    .replace(`\n## TOOL KNOWLEDGE\n\n${CREATE_TEACHING}\n`, `\n## TOOL KNOWLEDGE\n\n${SIGNAL_TEACHING_AT_4791CAB1}\n${CREATE_TEACHING}\n`);

const toolLine = (prompt: string, tool: string) => prompt.split("\n").filter((l) => l.startsWith(`- \`${tool}\`: `));

const GATE_MODES: Array<[string, () => ReturnType<typeof getZaruInit>]> = [
  ["workflow", () => getZaruInit("workflow")],
  ["workflow+chat-uploads", () => getZaruInit("workflow", new Set(["chat-uploads"]))],
  ["agentic", () => getZaruInit("agentic")],
  ["agentic+chat-uploads", () => getZaruInit("agentic", new Set(["chat-uploads"]))],
];

test("GC1: the workflow mode's prompt has no aegis.workflow.signal line and none of the sentences that taught the model to answer a gate; its run line says the gate is the person's control", () => {
  const failures: string[] = [];
  for (const [mode, init] of GATE_MODES.slice(0, 2)) {
    const prompt = init()!.system_prompt;
    const lines = toolLine(prompt, "aegis.workflow.signal");
    if (lines.length !== 0) failures.push(`the ${mode} prompt has ${lines.length} aegis.workflow.signal lines, not 0`);
    for (const sentence of GATE_RULE_SENTENCES) if (prompt.includes(sentence)) failures.push(`the ${mode} prompt holds: ${sentence}`);
    if (prompt.includes(SIGNAL_TEACHING)) failures.push(`the ${mode} prompt holds the signal line`);
    const run = toolLine(prompt, "aegis.workflow.run")[0] ?? "";
    if (!run.includes(GATE_CONTROL_SENTENCE)) failures.push(`the ${mode} run line lacks: ${GATE_CONTROL_SENTENCE}`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("GC2: the workflow mode's aegis.workflow.wait line shows the gate's prompt whole and waits, and never reads a run completed at a gate as a success", () => {
  const failures: string[] = [];
  for (const [mode, init] of GATE_MODES.slice(0, 2)) {
    const lines = toolLine(init()!.system_prompt, "aegis.workflow.wait");
    if (lines.length !== 1) {
      failures.push(`the ${mode} prompt has ${lines.length} aegis.workflow.wait lines, not 1`);
      continue;
    }
    for (const sentence of GATE_SHOWN_SENTENCES) if (!lines[0].includes(sentence)) failures.push(`the ${mode} wait line lacks: ${sentence}`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("GC3: the workflow and agentic modes' aegis.workflow.run line holds rule 2 (one run for one request) and rule 3 (draft_only is the person's choice, its value stated), the same line in both", () => {
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const [mode, init] of GATE_MODES) {
    const lines = toolLine(init()!.system_prompt, "aegis.workflow.run");
    if (lines.length !== 1) {
      failures.push(`the ${mode} prompt has ${lines.length} aegis.workflow.run lines, not 1`);
      continue;
    }
    // failed-run-told-once: the agentic line carries the later-read sentence before the started-run sentence (Zaru ADR-0026 D3c); it is compared without it.
    seen.add(lines[0].replace(` ${inputsReadSentence(INPUTS_TOOL[mode.split("+")[0]])}`, "").replace(` ${NO_PROMISE_SENTENCES[1]}`, ""));
    for (const sentence of [...ONE_RUN_SENTENCES, ...DRAFT_ONLY_SENTENCES])
      if (!lines[0].includes(sentence)) failures.push(`the ${mode} run line lacks: ${sentence}`);
  }
  if (seen.size > 1) failures.push(`the run line differs between the modes beyond the tool that answers the inputs (${seen.size} forms)`);
  assert.deepEqual(failures, [], failures.join("; "));
});

test("GC4: the agentic mode's aegis.workflow.wait line holds rule 1 without the signal: the gate is the person's and is never said to be answered; the agentic prompt teaches no aegis.workflow.signal", () => {
  const failures: string[] = [];
  for (const [mode, init] of GATE_MODES.slice(2)) {
    const prompt = init()!.system_prompt;
    const lines = toolLine(prompt, "aegis.workflow.wait");
    if (lines.length !== 1) failures.push(`the ${mode} prompt has ${lines.length} aegis.workflow.wait lines, not 1`);
    else for (const sentence of AGENTIC_GATE_SENTENCES) if (!lines[0].includes(sentence)) failures.push(`the ${mode} wait line lacks: ${sentence}`);
    if (toolLine(prompt, "aegis.workflow.signal").length !== 0) failures.push(`the ${mode} prompt teaches aegis.workflow.signal`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("GC5: no prompt names a gate word for the model to send; no other mode's prompt holds a gate-conduct sentence", () => {
  const failures: string[] = [];
  // The Forge's gate prompts (aegis-orchestrator de9acea3 the-forge.yaml 119,
  // 170) both read "Answer yes … or no with what to change."; the word is the
  // person's, sent from their own control, so no prompt teaches it.
  for (const [mode, init] of GATE_MODES) if (init()!.system_prompt.includes("`yes` or `no`, exactly")) failures.push(`the ${mode} prompt names \`yes\` or \`no\` for the model to send`);
  const all = [...GATE_RULE_SENTENCES, ...GATE_SHOWN_SENTENCES, ...AGENTIC_GATE_SENTENCES, ...ONE_RUN_SENTENCES, ...DRAFT_ONLY_SENTENCES, GATE_CONTROL_SENTENCE, ON_CONTROL_CLAUSE, AGENTIC_ON_CONTROL_CLAUSE, LOGS_AFTER_SENTENCE];
  for (const [mode, init] of ALL_MODES) {
    if (mode === "workflow" || mode === "agentic") continue;
    const prompt = init!.system_prompt;
    for (const sentence of all) if (prompt.includes(sentence)) failures.push(`the ${mode} prompt holds: ${sentence}`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("GC6: the workflow prompt's TOOL KNOWLEDGE opens with the run and wait lines, then the create line, each its own line; the agentic prompt's ends with the run and wait lines after the transcribe-audio line", () => {
  const failures: string[] = [];
  for (const [mode, init] of GATE_MODES.slice(0, 2)) {
    if (!init()!.system_prompt.includes(`\n## TOOL KNOWLEDGE\n\n${WORKFLOW_RUN_TEACHING}\n${WORKFLOW_WAIT_TEACHING}\n${CREATE_TEACHING}\n`))
      failures.push(`the ${mode} prompt's TOOL KNOWLEDGE does not open with the run and wait lines, then the create line`);
  }
  for (const [mode, init] of GATE_MODES.slice(2)) {
    if (!init()!.system_prompt.includes(`\n${TRANSCRIBE_TEACHING}\n${AGENTIC_RUN_TEACHING}\n${AGENTIC_WAIT_TEACHING}\n`))
      failures.push(`the ${mode} prompt does not hold the run and wait lines right after the transcribe-audio line`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

// ---------------------------------------------------------------------------
// Gate fidelity (AEGIS ADR-141's Update "Human gates approved through the MCP
// surface", Zaru ADR-0026's Update of 2026-10-12; Jeshua, 2026-10-12: "Zaru is
// the interface, it doesn't really "autonomously decide" outside of its
// interactions with the user (me)"). On the Forge run ec3f9b6b (conversation
// fc9f49c0, 2026-10-13), with the gate-conduct rules above deployed, Zaru in
// the workflow mode relayed both real gates and waited, but thirteen seconds
// after the person's design `yes` it answered with no tool call at all,
// narrating "Approval sent", "through tests and implementation" and a third
// gate "# The Forge: approve the review … Answer yes to commit the change"
// with a reviewer's verdict, "paused at AWAIT_REVIEW_APPROVAL", while the run
// waited at AWAIT_ARCH_APPROVAL (the Forge has two Human gates only,
// aegis-orchestrator de9acea3 the-forge.yaml 22, 108, 156); it said "The
// commit landed on the work branch" during TEST, which was false; it cut the
// requirements out of the design gate ("(as previously shown …)"); it called
// aegis.workflow.run first without the required `task`, `test_command` and
// `test_image`; and it called aegis.workflow.logs without `execution_id`.
// Three rules, each a sentence asserted below: (1) every gate, state, verdict
// and progress sentence is read from a tool's answer and quoted, never
// composed: a gate only as a tool answered it, whole, a later gate too; after
// a signal the state is read with aegis.workflow.wait or aegis.workflow.logs,
// or said not yet read; no commit, push, test or landing without a tool's
// answer; (2) before aegis.workflow.run the workflow's inputs are read from
// the tool of the mode's own list that answers them (aegis.workflow.list
// answers `input_schema` in the workflow mode, aegis.workflow.search in the
// agentic mode; aegis-orchestrator de9acea3 tool_invocation_service
// workflows.rs and discovery.rs) and a required input the request does not
// give is asked for; (3) aegis.workflow.logs and aegis.workflow.signal carry
// the `execution_id` the run answered. The agentic mode, which offers the run
// and the wait and neither the logs nor the signal, teaches (1) on its wait
// line and (2) on its run line. These tests pin the text; whether the model
// obeys it is proved on the live page only.
// ---------------------------------------------------------------------------

test("GF1: the workflow and agentic modes' aegis.workflow.wait line holds rule 1: every gate, state, verdict and progress sentence is read from a tool's answer and quoted; a gate only as a tool answered it, whole, a later gate too; no commit, push, test or landing without a tool's answer", () => {
  const failures: string[] = [];
  for (const [mode, init] of GATE_MODES) {
    const lines = toolLine(init()!.system_prompt, "aegis.workflow.wait");
    if (lines.length !== 1) {
      failures.push(`the ${mode} prompt has ${lines.length} aegis.workflow.wait lines, not 1`);
      continue;
    }
    for (const sentence of FIDELITY_SENTENCES) if (!lines[0].includes(sentence)) failures.push(`the ${mode} wait line lacks: ${sentence}`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("GF2: the workflow mode's logs line holds rule 1 after a gate: once the person says they answered it, the state is read with aegis.workflow.logs or aegis.workflow.wait, or said not yet read; no prompt holds the signal's sentences", () => {
  const failures: string[] = [];
  for (const [mode, init] of GATE_MODES.slice(0, 2)) {
    const prompt = init()!.system_prompt;
    const logs = toolLine(prompt, "aegis.workflow.logs")[0] ?? "";
    if (!logs.includes(LOGS_AFTER_SENTENCE)) failures.push(`the ${mode} logs line lacks: ${LOGS_AFTER_SENTENCE}`);
  }
  for (const [mode, init] of GATE_MODES) {
    const prompt = init()!.system_prompt;
    for (const sentence of [SIGNAL_ID_SENTENCE, SIGNAL_AFTER_SENTENCE]) if (prompt.includes(sentence)) failures.push(`the ${mode} prompt holds: ${sentence}`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("GF3: the workflow mode teaches aegis.workflow.logs once, its execution_id always the one the run answered, as the TOOL KNOWLEDGE line right after aegis.workflow.update; the tool is on the workflow list", () => {
  const failures: string[] = [];
  for (const [mode, init] of GATE_MODES.slice(0, 2)) {
    const zaru = init()!;
    const lines = toolLine(zaru.system_prompt, "aegis.workflow.logs");
    if (lines.length !== 1) {
      failures.push(`the ${mode} prompt has ${lines.length} aegis.workflow.logs lines, not 1`);
      continue;
    }
    if (!lines[0].includes(LOGS_ID_SENTENCE)) failures.push(`the ${mode} logs line lacks: ${LOGS_ID_SENTENCE}`);
    if (!zaru.system_prompt.includes(`\n${UPDATE_TEACHING}\n${WORKFLOW_LOGS_TEACHING}\n`))
      failures.push(`the ${mode} prompt's logs line is not its own line right after the aegis.workflow.update line`);
    if (!zaru.available_tools.includes("aegis.workflow.logs")) failures.push(`the ${mode} list does not offer aegis.workflow.logs`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("GF4: the workflow and agentic modes' aegis.workflow.run line holds rule 2: the inputs read first from the mode's own tool that answers them (aegis.workflow.list, aegis.workflow.search), and every required input the request does not give asked for, test_command and test_image named", () => {
  const failures: string[] = [];
  for (const [mode, init] of GATE_MODES) {
    const zaru = init()!;
    const base = mode.split("+")[0];
    const tool = INPUTS_TOOL[base];
    const other = INPUTS_TOOL[base === "workflow" ? "agentic" : "workflow"];
    const lines = toolLine(zaru.system_prompt, "aegis.workflow.run");
    if (lines.length !== 1) {
      failures.push(`the ${mode} prompt has ${lines.length} aegis.workflow.run lines, not 1`);
      continue;
    }
    for (const sentence of [inputsReadSentence(tool), INPUTS_ASK_SENTENCE]) if (!lines[0].includes(sentence)) failures.push(`the ${mode} run line lacks: ${sentence}`);
    if (!zaru.available_tools.includes(tool)) failures.push(`the ${mode} list does not offer ${tool}, which its run line names`);
    if (lines[0].includes(other)) failures.push(`the ${mode} run line names ${other}, which its list does not offer`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("GF5: no other mode's prompt holds a gate-fidelity sentence; the agentic prompt teaches no aegis.workflow.logs and its list offers none", () => {
  const failures: string[] = [];
  const all = [...FIDELITY_SENTENCES, SIGNAL_ID_SENTENCE, SIGNAL_AFTER_SENTENCE, LOGS_ID_SENTENCE, LOGS_AFTER_SENTENCE, AGENTIC_AFTER_SENTENCE, INPUTS_ASK_SENTENCE, ...Object.values(INPUTS_TOOL).map(inputsReadSentence)];
  for (const [mode, init] of ALL_MODES) {
    if (mode === "workflow" || mode === "agentic") continue;
    const prompt = init!.system_prompt;
    for (const sentence of all) if (prompt.includes(sentence)) failures.push(`the ${mode} prompt holds: ${sentence}`);
  }
  for (const [mode, init] of GATE_MODES.slice(2)) {
    const zaru = init()!;
    if (toolLine(zaru.system_prompt, "aegis.workflow.logs").length !== 0) failures.push(`the ${mode} prompt teaches aegis.workflow.logs`);
    if (zaru.available_tools.includes("aegis.workflow.logs")) failures.push(`the ${mode} list offers aegis.workflow.logs`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

// ---------------------------------------------------------------------------
// The signal leaves the modes (AEGIS ADR-141's Update "Human gates approved
// through the MCP surface"; Jeshua, 2026-10-13T02:19:18Z: "Zaru Web should not
// have access to approve, because that defeats the purpose."; 02:22:31Z: "The
// approval gate can still be exposed via Zaru MCP for external MCP
// integrations like Claude code"). A model that holds aegis.workflow.signal
// can answer a gate itself (run 9f279438) or narrate an answer it never sent
// (run ec3f9b6b). A Human gate is answered by the person on their own control,
// never by the model's tool call: no mode's tool list names the signal and no
// mode's prompt teaches it; the run, wait and logs lines say the gate is the
// person's control, name where they answer it (since the gate card, the card
// under the run, Approvals or the run's execution page: GK1 below), ask for
// no answer in the chat, and read the state
// once the person says they answered. The tool itself stays: tools/list is the
// orchestrator's catalogue for the caller, relayed unfiltered, so an external
// MCP client (Claude Code) still lists and calls aegis.workflow.signal; the
// mode lists are what Zaru's companion is offered and taught. These tests pin
// the text and the lists; whether the model obeys is proved on the live page.
// ---------------------------------------------------------------------------

const SIGNAL = "aegis.workflow.signal";

/** Every mode's init, with the capability forms that change a prompt. */
const SIGNAL_MODES: Array<[string, () => ReturnType<typeof getZaruInit>]> = [
  ["chat", () => getZaruInit("chat")],
  ["agentic", () => getZaruInit("agentic")],
  ["agentic+chat-uploads", () => getZaruInit("agentic", new Set(["chat-uploads"]))],
  ["workflow", () => getZaruInit("workflow")],
  ["workflow+chat-uploads", () => getZaruInit("workflow", new Set(["chat-uploads"]))],
  ["execute", () => getZaruInit("execute")],
  ["live", () => getZaruInit("live", new Set(["live"]), "browser")],
  ["vibecode", () => getZaruInit("vibecode", new Set(["vibecode"]), "browser")],
  ["operator", () => getZaruInit("operator", new Set(), undefined, { isOperator: true, tier: "operator" })],
];

test("SR1: no mode's tool list names aegis.workflow.signal", () => {
  const failures: string[] = [];
  for (const [mode, init] of SIGNAL_MODES) if (init()!.available_tools.includes(SIGNAL)) failures.push(`the ${mode} list names ${SIGNAL}`);
  assert.deepEqual(failures, [], failures.join("; "));
});

test("SR2: no mode's prompt names aegis.workflow.signal, and the workflow and agentic prompts carry no sentence that tells the model to answer, signal or approve a gate", () => {
  const failures: string[] = [];
  for (const [mode, init] of SIGNAL_MODES) if (init()!.system_prompt.includes(SIGNAL)) failures.push(`the ${mode} prompt names ${SIGNAL}`);
  const taught = [
    ...GATE_RULE_SENTENCES,
    SIGNAL_ID_SENTENCE,
    SIGNAL_AFTER_SENTENCE,
    "Answer a run's Human gate with the person's own answer.",
    "Never say a gate was approved without this tool's answer.",
    "then end your turn and wait for their answer.",
  ];
  const answering = /\b(answer|answers|answered|answering|signal\w*|approv\w*)\b/i;
  for (const [mode, init] of GATE_MODES) {
    const prompt = init()!.system_prompt;
    for (const sentence of taught) if (prompt.includes(sentence)) failures.push(`the ${mode} prompt holds: ${sentence}`);
    // A sentence that names a gate with an answering, signalling or approving
    // word is a prohibition ("never") or the person's own report ("the person
    // says they have answered"); none is an instruction. ("signal" as a plain
    // noun elsewhere, as in the memory teaching, names no gate.)
    for (const sentence of prompt.split(/(?<=\.)\s+/)) {
      const aboutGate = /\bgates?\b/i.test(sentence) && answering.test(sentence);
      if (aboutGate && !/\bnever\b/i.test(sentence) && !sentence.includes("the person says they have answered"))
        failures.push(`the ${mode} prompt tells the model to answer a gate: ${sentence}`);
    }
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("SR3: the workflow and agentic prompts each carry the sentence that a Human gate is the person's control, name where the person answers it, ask for no yes or no in the chat, and read the state after the person says they answered", () => {
  const failures: string[] = [];
  for (const [mode, init] of GATE_MODES) {
    const prompt = init()!.system_prompt;
    const run = toolLine(prompt, "aegis.workflow.run")[0] ?? "";
    const wait = toolLine(prompt, "aegis.workflow.wait")[0] ?? "";
    if (!run.includes(GATE_CONTROL_SENTENCE)) failures.push(`the ${mode} run line lacks: ${GATE_CONTROL_SENTENCE}`);
    const clause = mode.startsWith("workflow") ? ON_CONTROL_CLAUSE : AGENTIC_ON_CONTROL_CLAUSE;
    if (!wait.includes(clause)) failures.push(`the ${mode} wait line lacks: ${clause}`);
    const after = mode.startsWith("workflow") ? toolLine(prompt, "aegis.workflow.logs")[0] ?? "" : wait;
    const sentence = mode.startsWith("workflow") ? LOGS_AFTER_SENTENCE : AGENTIC_AFTER_SENTENCE;
    if (!after.includes(sentence)) failures.push(`the ${mode} prompt lacks: ${sentence}`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("SR4: the server still lists aegis.workflow.signal on tools/list for a Zaru Web user and an external MCP client, from the orchestrator's catalogue, while no mode's list names it", async () => {
  const catalogue = [
    { name: SIGNAL, description: "Answer a run's Human gate.", inputSchema: { type: "object", properties: {} } },
    { name: "aegis.workflow.wait", description: "Wait for a run.", inputSchema: { type: "object", properties: {} } },
  ];
  const users: Record<string, ZaruUser> = {
    zaru_web_user: { userId: "u-1", tier: "free", securityContext: "ctx-1", token: "a.b.c", isOperator: false },
    external_api_key: { userId: "u-3", tier: "pro", securityContext: "ctx-3", token: "aegis_key", isOperator: false },
  };
  const failures: string[] = [];
  for (const [name, user] of Object.entries(users)) {
    const orchestrator = new OrchestratorClient({
      baseUrl: "http://orchestrator.invalid",
      fetchImpl: async () =>
        new Response(JSON.stringify(catalogue), { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    const server = createMcpServerForUser(user, new Set(), "signal-stays", orchestrator);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "signal-stays", version: "0" });
    await client.connect(clientSide);
    try {
      const { tools } = await client.listTools();
      if (!tools.some((tool) => tool.name === SIGNAL)) failures.push(`tools/list for ${name} does not list ${SIGNAL}`);
    } finally {
      await client.close();
    }
  }
  for (const [mode, init] of SIGNAL_MODES) if (init()!.available_tools.includes(SIGNAL)) failures.push(`the ${mode} list names ${SIGNAL}`);
  assert.deepEqual(failures, [], failures.join("; "));
});

// ---------------------------------------------------------------------------
// The gate card (Zaru ADR-0058's Update "gate-card-2026-10-13", D5g to D5k;
// Jeshua, 2026-10-13T02:19:18Z: "Zaru Web should not have access to approve,
// because that defeats the purpose."; on the gate joining the approvals
// queue, screen and chat card, 02:27:01Z: "Perfect"). Zaru Web shows a run's
// pending Human gate as a card under the run in the conversation that started
// it, on Approvals and on the run's execution page (zaru-client 70381f63). The
// workflow and agentic modes name those three places, in those words, where
// the person answers; the run waits for the answer there and Zaru ends its
// turn, never asks for the answer in the chat, and never says the gate was
// answered unless the tools of the mode's own list that read the run answer
// so (the workflow mode's aegis.workflow.wait and aegis.workflow.logs; the
// agentic mode's aegis.workflow.wait, its list offering no logs). The
// execution page on the AEGIS dashboard is no longer named alone.
// ---------------------------------------------------------------------------


test("GK1: the workflow and agentic wait lines name the card under the run, Approvals and the run's execution page as where the person answers, end the turn, ask for no answer in the chat and say no gate answered unless the mode's own run-reading tools answer so; no prompt names the dashboard page alone", () => {
  const failures: string[] = [];
  for (const [mode, init] of GATE_MODES) {
    const zaru = init()!;
    const base = mode.split("+")[0];
    const wait = toolLine(zaru.system_prompt, "aegis.workflow.wait")[0] ?? "";
    const clause = gatePlaceClause(base);
    if (!wait.includes(clause)) failures.push(`the ${mode} wait line lacks: ${clause}`);
    if (zaru.system_prompt.includes("execution page on the AEGIS dashboard")) failures.push(`the ${mode} prompt names the execution page on the AEGIS dashboard`);
    for (const tool of GATE_READERS[base].split(" or ")) if (!zaru.available_tools.includes(tool)) failures.push(`the ${mode} wait line names ${tool}, which its list does not offer`);
  }
  for (const [mode, init] of SIGNAL_MODES) {
    if (mode.startsWith("workflow") || mode.startsWith("agentic")) continue;
    const prompt = init()!.system_prompt;
    if (prompt.includes(GATE_PLACES)) failures.push(`the ${mode} prompt names where a gate is answered`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

// ---------------------------------------------------------------------------
// Run, then yield (Jeshua, 2026-10-13T05:08:30Z, on a conversation where Zaru
// spent its turn's steps on aegis.workflow.wait and aegis.workflow.logs calls
// answering "Still running", then ended on "I used all my steps for this turn
// before finishing.": "Should we double the number of steps in workflow and
// agentic mode?"). Not the budget but the conduct: Zaru Web shows a run's
// state as it runs under the run (zaru-client 57270834: a wait card that read
// running reads the run every five seconds until it ends; a workflow run on
// its own route, an agent, task or execute run on /api/executions/{id}) and a
// run's Human gate as a card under the run and on Approvals (70381f63), so
// the companion has nothing to poll for. After aegis.workflow.run answers
// started, Zaru says so with the execution_id, where the run's state and its
// gates will show, and ends its turn; it reads a run at most once a turn,
// only when the person asks about it, never in a loop; a read that answers
// running is one sentence and the end of the turn. The agentic mode's agent
// and task waits, and the workflow mode's, follow the same rule when their
// answer reads running. These tests pin the text; whether the model obeys it
// is proved on the live page only.
// ---------------------------------------------------------------------------

/** Sentences that told the model to keep waiting, poll or repeat a wait. */
const KEEP_WAITING = [
  /keep (calling|waiting|polling)/i,
  /continue (the |to )?wait/i,
  /\bpoll(s|ing|ed)?\b/i,
  /wait for it to return/i,
  /Call it once and wait\b/,
  /blocks server-side until/i,
  /wait again if/i,
  /repeat (this|the same)\b[^.]*\bcall/i,
  /call aegis\.workflow\.wait with the execution_id it returns/,
];

test("RY1: the workflow and agentic run lines end the turn after a started run, saying the execution_id, the card above and the gates there and on Approvals; no other mode's prompt holds it", () => {
  const failures: string[] = [];
  for (const [mode, init] of GATE_MODES) {
    const run = toolLine(init()!.system_prompt, "aegis.workflow.run")[0] ?? "";
    if (!run.includes(STARTED_RUN_SENTENCE)) failures.push(`the ${mode} run line lacks: ${STARTED_RUN_SENTENCE}`);
  }
  for (const [mode, init] of SIGNAL_MODES) {
    if (mode.startsWith("workflow") || mode.startsWith("agentic")) continue;
    if (init()!.system_prompt.includes(STARTED_RUN_SENTENCE)) failures.push(`the ${mode} prompt holds the started-run sentence`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("RY2: the workflow and agentic wait lines read a run at most once a turn, only when the person asks, never in a loop, and a running answer is one sentence and the end of the turn; the workflow logs line the same, for a gate's prompt, the history or an ended run", () => {
  const failures: string[] = [];
  for (const [mode, init] of GATE_MODES) {
    const prompt = init()!.system_prompt;
    const wait = toolLine(prompt, "aegis.workflow.wait")[0] ?? "";
    for (const sentence of WAIT_ONCE_SENTENCES) if (!wait.includes(sentence)) failures.push(`the ${mode} wait line lacks: ${sentence}`);
    if (mode.startsWith("workflow")) {
      const logs = toolLine(prompt, "aegis.workflow.logs")[0] ?? "";
      for (const sentence of LOGS_WHEN_SENTENCES) if (!logs.includes(sentence)) failures.push(`the ${mode} logs line lacks: ${sentence}`);
    }
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("RY3: the agentic Steps 2 and 3 and the workflow Steps 3 and 5 read their wait once and end the turn on a running answer; agentic Step 1 ends the turn after a started workflow run", () => {
  const failures: string[] = [];
  const step = (prompt: string, from: string, to: string) => {
    const start = prompt.indexOf(from);
    return start < 0 ? "" : prompt.slice(start, prompt.indexOf(to, start));
  };
  const holders: Array<[string, string, string, string]> = [
    ["agentic", "**Step 2", "**Step 3", EXECUTION_RUNNING_SENTENCE],
    ["agentic", "**Step 3", "**Step 4", EXECUTION_RUNNING_SENTENCE],
    ["workflow", "**Step 3", "**Step 4", GENERATE_RUNNING_SENTENCE],
    ["workflow", "**Step 5", "**Step 6", EXECUTION_RUNNING_SENTENCE],
  ];
  for (const [mode, init] of GATE_MODES) {
    const prompt = init()!.system_prompt;
    for (const [holder, from, to, sentence] of holders) {
      if (!mode.startsWith(holder)) continue;
      if (!step(prompt, from, to).includes(sentence)) failures.push(`the ${mode} ${from.slice(2)} lacks: ${sentence}`);
    }
    if (mode.startsWith("agentic") && !step(prompt, "**Step 1", "**Step 2").includes(AGENTIC_STEP1_WORKFLOW))
      failures.push(`the ${mode} Step 1 does not end the turn after a started workflow run`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("RY4: the workflow and agentic prompts carry no sentence that tells the model to keep waiting, poll, repeat a wait or continue the wait", () => {
  const failures: string[] = [];
  for (const [mode, init] of GATE_MODES) {
    for (const sentence of init()!.system_prompt.split(/(?<=[.!?])\s+/))
      for (const pattern of KEEP_WAITING) if (pattern.test(sentence)) failures.push(`the ${mode} prompt holds (${pattern}): ${sentence}`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

// run-then-yield-C1: before the run, `task` is the person's request in their
// own words (forge-browser-proof-5, 04:56Z: the first call was refused
// "Input validation failed: "task" is a required property" although the
// person's sentence was the task; the second sent a composed task "Make a
// small, sensible change to README.md (fix a typo, …)").

test("RY5: the workflow and agentic run lines name `task` as the person's own words, never a paraphrase and never left out, right after the required inputs are asked for; no other mode's prompt holds it", () => {
  const failures: string[] = [];
  for (const [mode, init] of GATE_MODES) {
    const run = toolLine(init()!.system_prompt, "aegis.workflow.run")[0] ?? "";
    if (!run.includes(`${INPUTS_ASK_SENTENCE} ${TASK_WORDS_SENTENCE}`)) failures.push(`the ${mode} run line lacks, after the inputs sentence: ${TASK_WORDS_SENTENCE}`);
  }
  for (const [mode, init] of SIGNAL_MODES) {
    if (mode.startsWith("workflow") || mode.startsWith("agentic")) continue;
    if (init()!.system_prompt.includes(TASK_WORDS_SENTENCE)) failures.push(`the ${mode} prompt holds the task sentence`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

// run-then-yield-C2: the operator and execute modes' lines that told the
// model to wait again or keep calling a wait read the same rule: a wait that
// answers running is one sentence and the end of the turn; read again only
// when the person asks, never in a loop.
const OPERATOR_RUNNING_LINE =
  "- If aegis.workflow.wait returns before the workflow finishes, say in one sentence that it is still running, with its `execution_id`, and end your turn; read it again only when the person asks, never in a loop.";
const EXECUTE_RUNNING_LINE =
  "- If aegis.execute.wait returns with status \"running\" (server-side timeout before pipeline finished), say in one sentence that it is still running, with its `execution_id`, and end your turn; call aegis.execute.wait again only when the person asks, never in a loop. Do NOT fall back to aegis.execute.status — always use aegis.execute.wait.";

test("RY6: the operator and execute prompts end the turn on a running wait and no longer tell the model to wait again or keep calling the wait", () => {
  const failures: string[] = [];
  const operator = getZaruInit("operator", new Set(), undefined, { isOperator: true, tier: "operator" })!.system_prompt;
  const execute = getZaruInit("execute")!.system_prompt;
  if (!operator.split("\n").includes(OPERATOR_RUNNING_LINE)) failures.push(`the operator prompt lacks: ${OPERATOR_RUNNING_LINE}`);
  if (!execute.split("\n").includes(EXECUTE_RUNNING_LINE)) failures.push(`the execute prompt lacks: ${EXECUTE_RUNNING_LINE}`);
  for (const [mode, prompt] of [["operator", operator], ["execute", execute]] as const)
    for (const pattern of [/wait again if/i, /keep calling/i, /AGAIN with the same execution_id/])
      if (pattern.test(prompt)) failures.push(`the ${mode} prompt holds ${pattern}`);
  assert.deepEqual(failures, [], failures.join("; "));
});

// gate-promise-wording: after the run started, Zaru wrote "Each gate will
// appear on the card and in Approvals for you to answer there; I'll surface
// each gate's prompt here, verbatim, when the run reaches it." (Jeshua,
// 2026-10-13T07:41:22Z, watching forge-browser-proof-6's run 7a237b3a). Its
// turn had ended and nothing of it watches the run, so the promise could not
// be kept: the gate is the person's, on the card and in Approvals, and the
// companion neither relays nor answers it.

/** A sentence in which the companion promises to come back with a gate. */
const GATE_PROMISE = [/\bI'll\b/i, /\bI will\b/i, /\bsurface/i, /when the run reaches it/i];

test("GP1: the workflow and agentic run lines say each Human gate appears on the card and in Approvals for the person to answer there, and forbid any promise for after the turn; no other mode's prompt holds it", () => {
  const failures: string[] = [];
  for (const [mode, init] of GATE_MODES) {
    const run = toolLine(init()!.system_prompt, "aegis.workflow.run")[0] ?? "";
    if (!run.includes("each Human gate appears on that card and in Approvals, the badge in the header, for them to answer there"))
      failures.push(`the ${mode} run line does not say the gates appear on the card and in Approvals`);
    // failed-run-told-once: the agentic line ends with the no-promise sentence, its later-read sentence before the started-run sentence (Zaru ADR-0026 D3c).
    const after = mode.startsWith("agentic") ? NO_PROMISE_SENTENCES[0] : NO_PROMISE_SENTENCES.join(" ");
    if (!run.includes(`${STARTED_RUN_SENTENCE} ${after}`))
      failures.push(`the ${mode} run line lacks, after the started-run sentence: ${after}`);
    if (mode.startsWith("agentic") && !run.includes(`${NO_PROMISE_SENTENCES[1]} ${STARTED_RUN_SENTENCE}`))
      failures.push(`the ${mode} run line lacks, before the started-run sentence: ${NO_PROMISE_SENTENCES[1]}`);
  }
  for (const [mode, init] of SIGNAL_MODES) {
    if (mode.startsWith("workflow") || mode.startsWith("agentic")) continue;
    for (const sentence of NO_PROMISE_SENTENCES) if (init()!.system_prompt.includes(sentence)) failures.push(`the ${mode} prompt holds: ${sentence}`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("GP2: the workflow and agentic prompts carry no gate sentence in which the companion promises to surface, relay or show a gate later (\"I'll\", \"I will\", \"surface\", \"when the run reaches it\") or says a gate \"will appear\"", () => {
  const failures: string[] = [];
  for (const [mode, init] of GATE_MODES) {
    for (const sentence of init()!.system_prompt.split(/(?<=[.!?])\s+/)) {
      if (!/\bgates?\b/i.test(sentence)) continue;
      for (const pattern of [...GATE_PROMISE, /\bwill appear\b/i]) if (pattern.test(sentence)) failures.push(`the ${mode} prompt holds (${pattern}): ${sentence}`);
    }
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

// card-above-wording: the chat renders a run's cards above the companion's
// answer, yet the answer placed its card beneath it ("... shows its state as
// it works") under the "Waited for the work" and "The agent is working on it"
// cards (Jeshua, 2026-10-14T19:28Z, his screenshot; Zaru known-defects-8 row
// zaru-card-below-wording). The
// same agentic answer ended "I'll report the evaluation as soon as it lands",
// a promise for after the turn that the agentic run line forbade by one
// example only (row zaru-promises-to-report-after-run): the workflow run
// line's no-promise sentence is carried onto the agentic run line and the
// workflow test-execution line.

/** A card placed beneath the answer, where the chat renders it above. */
const CARD_BENEATH = /\bcard\s+below\b/i;

test("CA1: no mode's prompt places a card beneath the answer; the agentic and workflow prompts point to \"the card above\"", () => {
  const failures: string[] = [];
  for (const [mode, init] of UNCHANGED_PROMPTS) {
    const prompt = init()!.system_prompt;
    const beneath = prompt.match(CARD_BENEATH);
    if (beneath) failures.push(`the ${mode} prompt says "${beneath[0]}"`);
    if ((mode.startsWith("agentic") || mode.startsWith("workflow")) && !prompt.includes("the card above"))
      failures.push(`the ${mode} prompt does not say "the card above"`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

const stepText = (prompt: string, from: string, to: string) => {
  const start = prompt.indexOf(from);
  return start < 0 ? "" : prompt.slice(start, prompt.indexOf(to, start));
};

test("CA2: the agentic run line (Step 3, aegis.task.execute) promises nothing for after the turn, in the workflow run line's sentence, after its running sentence", () => {
  const failures: string[] = [];
  for (const [mode, init] of GATE_MODES) {
    if (!mode.startsWith("agentic")) continue;
    const step = stepText(init()!.system_prompt, "**Step 3", "**Step 4");
    if (!step.includes(`${EXECUTION_RUNNING_SENTENCE} ${EXECUTION_NO_PROMISE_SENTENCE}`))
      failures.push(`the ${mode} Step 3 lacks, after the running sentence: ${EXECUTION_NO_PROMISE_SENTENCE}`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("CA3: the workflow test-execution line (Step 5, aegis.task.execute) promises nothing for after the turn, in the workflow run line's sentence, after its running sentence", () => {
  const failures: string[] = [];
  for (const [mode, init] of GATE_MODES) {
    if (!mode.startsWith("workflow")) continue;
    const step = stepText(init()!.system_prompt, "**Step 5", "**Step 6");
    if (!step.includes(`${EXECUTION_RUNNING_SENTENCE} ${EXECUTION_NO_PROMISE_SENTENCE}`))
      failures.push(`the ${mode} Step 5 lacks, after the running sentence: ${EXECUTION_NO_PROMISE_SENTENCE}`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

// failed-run-told-once: in agentic mode the companion started transcribe-audio
// and ended its turn "I'll have the transcript for you once it completes.";
// the run failed with its feedback sentence, and eight lines of verifying and
// searching followed, none telling the person the run had failed (Jeshua,
// 2026-10-15, conversation e6d17940; Zaru known-defects-9 row
// companion-loops-after-failed-run-2026-10-15, known-defects-8 row
// zaru-promises-to-report-after-run; Zaru ADR-0026's Update of 2026-10-15,
// D3b to D3d; AEGIS ADR-143 S7c's teaching). Every agentic line that starts a
// workflow run ends with the no-promise sentence; the transcription line sends
// the model to no wait; every mode that reads a run tells a failed run once,
// with the run's own failure sentence, and ends the turn there.

/** The no-promise sentence, in the form the run line carries it. */
const FR_NO_PROMISE = NO_PROMISE_SENTENCES[0];

/** D3c's transcription line, its three sentences, with S7c's teaching and the call it names between its first and its second. */
const FR_TRANSCRIBE_LINE =
  "- To turn an attached recording into text, run the workflow transcribe-audio with it. The run is aegis.workflow.run with `name` `transcribe-audio`, and the chat carries the attachment to the run. `input.audio_path` may be left out when one file is attached; otherwise it is the file's name exactly as the chat's attachment marker gives it. The transcript is the run's answer, which reaches the person on the card above. Tell the person the run has started and end your turn; your turn ends there and nothing of yours watches the run after it: promise nothing for after your turn.";

/** D3b in the model's words, after the readers of the mode. */
const FR_FAILED_RUN_RULE =
  "shows that a run you started failed, tell the person in one sentence that it failed, carrying the run's own failure sentence: the `feedback` of the transition it failed on where the run gives one, otherwise the state it failed in and the first line of that state's error. End your turn at that sentence: do not search, verify, retry or start the run again unless the person asks.";

/** The readers of a run each mode holds: the two waits, and in agentic mode the Goal check. */
const FR_READERS: Record<string, string> = {
  agentic: "When aegis.workflow.wait's or aegis.task.wait's answer, or a Goal check,",
  workflow: "When aegis.workflow.wait's or aegis.task.wait's answer",
  operator: "When aegis.workflow.wait's or aegis.task.wait's answer",
};

const FR_ALL_MODES: Array<[string, ReturnType<typeof getZaruInit>]> = [
  ...ALL_MODES,
  ["agentic+chat-uploads", getZaruInit("agentic", new Set(["chat-uploads"]))],
  ["workflow+chat-uploads", getZaruInit("workflow", new Set(["chat-uploads"]))],
];

test("FR1: the agentic Step 1's workflow branch ends with the no-promise sentence", () => {
  const failures: string[] = [];
  for (const [mode, init] of GATE_MODES) {
    if (!mode.startsWith("agentic")) continue;
    const s1 = stepText(init()!.system_prompt, "**Step 1", "**Step 2");
    const branch = s1.slice(s1.indexOf("If a matching workflow exists"), s1.indexOf(" Do NOT create a duplicate."));
    if (!branch.startsWith("If a matching workflow exists") || !branch.endsWith(` ${FR_NO_PROMISE}`))
      failures.push(`the ${mode} Step 1 workflow branch does not end with: ${FR_NO_PROMISE}`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("FR2: the agentic aegis.workflow.run line ends with the no-promise sentence", () => {
  const failures: string[] = [];
  for (const [mode, init] of GATE_MODES) {
    if (!mode.startsWith("agentic")) continue;
    const run = toolLine(init()!.system_prompt, "aegis.workflow.run")[0] ?? "";
    if (!run.endsWith(` ${FR_NO_PROMISE}`)) failures.push(`the ${mode} run line does not end with: ${FR_NO_PROMISE}`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("FR3: the agentic transcription line is D3c's, with S7c's teaching; it ends with the no-promise sentence and names no aegis.workflow.wait", () => {
  const failures: string[] = [];
  for (const [mode, init] of GATE_MODES) {
    if (!mode.startsWith("agentic")) continue;
    const lines = init()!.system_prompt.split("\n").filter((l) => l.startsWith("- To turn an attached recording into text"));
    if (lines.length !== 1) {
      failures.push(`the ${mode} prompt holds ${lines.length} transcription lines, not one`);
      continue;
    }
    const [line] = lines;
    if (line !== FR_TRANSCRIBE_LINE) failures.push(`the ${mode} transcription line is not D3c's with S7c's teaching: ${line}`);
    if (line.includes("aegis.workflow.wait")) failures.push(`the ${mode} transcription line names aegis.workflow.wait`);
    if (!line.endsWith("your turn ends there and nothing of yours watches the run after it: promise nothing for after your turn."))
      failures.push(`the ${mode} transcription line does not end with the no-promise sentence`);
    if (!line.includes("`input.audio_path` may be left out when one file is attached; otherwise it is the file's name exactly as the chat's attachment marker gives it."))
      failures.push(`the ${mode} transcription line lacks S7c's teaching`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("FR4: every mode whose tools read a run (aegis.workflow.wait or aegis.task.wait) tells a failed run once, with its own failure sentence, and ends the turn; agentic names the Goal check; no other mode holds the rule", () => {
  const failures: string[] = [];
  for (const [mode, init] of FR_ALL_MODES) {
    const base = mode.split("+")[0];
    const reads = init!.available_tools.some((t) => t === "aegis.workflow.wait" || t === "aegis.task.wait");
    const prompt = init!.system_prompt;
    const count = prompt.split(FR_FAILED_RUN_RULE).length - 1;
    if (reads) {
      const readers = FR_READERS[base];
      if (!readers) failures.push(`the ${mode} mode reads a run and has no readers named`);
      else if (count !== 1 || !prompt.includes(`${readers} ${FR_FAILED_RUN_RULE}`))
        failures.push(`the ${mode} prompt does not hold, once: ${readers} ${FR_FAILED_RUN_RULE}`);
    } else if (count !== 0) failures.push(`the ${mode} prompt, whose tools read no run, holds the failed-run rule`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});
