import test from "node:test";
import assert from "node:assert/strict";

import { appendMemoryToSystemPrompt } from "../src/prompts/index.js";

// ---------------------------------------------------------------------------
// appendMemoryToSystemPrompt — pure function (ADR-118)
//
// Renders the user's pre-fetched memory blob beneath the resolved mode
// prompt, under a `## Your Memory About This User` heading. Empty / blank
// content is replaced with an explicit placeholder so the LLM is reminded
// the tool exists and what to do with it.
// ---------------------------------------------------------------------------

const HEADING = "## Your Memory About This User";
const EMPTY_STUB =
  "No memory yet — use zaru.memory.set to start building it as you learn about this user.";

test("appendMemoryToSystemPrompt: empty content renders the empty-memory stub", () => {
  const result = appendMemoryToSystemPrompt("BASE PROMPT", { content: "" });
  assert.equal(result, `BASE PROMPT\n\n${HEADING}\n\n${EMPTY_STUB}`);
});

test("appendMemoryToSystemPrompt: whitespace-only content also renders the stub", () => {
  const result = appendMemoryToSystemPrompt("BASE PROMPT", {
    content: "   \n\t  \n",
  });
  assert.equal(result, `BASE PROMPT\n\n${HEADING}\n\n${EMPTY_STUB}`);
});

test("appendMemoryToSystemPrompt: real content is appended verbatim under the heading", () => {
  const memory =
    "- Prefers concise replies.\n- Working on AEGIS platform.\n- Uses bullet points.";
  const result = appendMemoryToSystemPrompt("BASE PROMPT", { content: memory });
  assert.equal(result, `BASE PROMPT\n\n${HEADING}\n\n${memory}`);
});

test("appendMemoryToSystemPrompt: leading/trailing whitespace inside non-empty content is preserved", () => {
  // Only fully empty / whitespace-only triggers the stub. Real content with
  // trailing whitespace is passed through unchanged.
  const memory = "  - real entry  ";
  const result = appendMemoryToSystemPrompt("BASE PROMPT", { content: memory });
  assert.equal(result, `BASE PROMPT\n\n${HEADING}\n\n${memory}`);
});

test("appendMemoryToSystemPrompt: does not mutate the existing system prompt body", () => {
  const original = `# WHO YOU ARE\n\nYou are Zaru.\n\n# YOUR MEMORY ABOUT THIS USER\n\nlive doc...`;
  const result = appendMemoryToSystemPrompt(original, { content: "fact" });
  // The full original prompt (including the pre-existing memory paragraph)
  // must appear unchanged at the start. The function appends; it does not
  // splice or replace the in-prompt teaching.
  assert.ok(result.startsWith(original));
  assert.ok(result.endsWith(`${HEADING}\n\nfact`));
});

test("appendMemoryToSystemPrompt: separator between prompt and heading is exactly two newlines", () => {
  const result = appendMemoryToSystemPrompt("X", { content: "Y" });
  assert.equal(result, `X\n\n${HEADING}\n\nY`);
});

test("appendMemoryToSystemPrompt: heading and body are separated by exactly two newlines", () => {
  const result = appendMemoryToSystemPrompt("PROMPT", { content: "BODY" });
  const idx = result.indexOf(HEADING);
  assert.notEqual(idx, -1);
  // After the heading there should be exactly "\n\n" before the body.
  const after = result.slice(idx + HEADING.length);
  assert.equal(after, `\n\nBODY`);
});

test("appendMemoryToSystemPrompt: idempotent shape — calling twice with same args yields identical output", () => {
  const a = appendMemoryToSystemPrompt("P", { content: "M" });
  const b = appendMemoryToSystemPrompt("P", { content: "M" });
  assert.equal(a, b);
});

test("appendMemoryToSystemPrompt: empty prompt + empty content still renders heading and stub", () => {
  const result = appendMemoryToSystemPrompt("", { content: "" });
  assert.equal(result, `\n\n${HEADING}\n\n${EMPTY_STUB}`);
});

test("appendMemoryToSystemPrompt: content containing the heading text is NOT special-cased (pure append)", () => {
  // Defensive: the function is a pure append. If a future memory blob happens
  // to include the heading string, we don't try to dedupe — the function's
  // contract is "append unconditionally".
  const memory = `${HEADING}\n\nfact`;
  const result = appendMemoryToSystemPrompt("BASE", { content: memory });
  assert.equal(result, `BASE\n\n${HEADING}\n\n${memory}`);
});
