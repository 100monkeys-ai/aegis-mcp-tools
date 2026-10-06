// The person ends a goal (AEGIS ADR-131 U33; correction goal-cancel-C1, G2):
// every mode that creates goals lists aegis.goal.cancel, the agentic,
// workflow and execute prompts name it as the answer when the person asks
// to stop, and zaru.chat's description names it and every state a goal ends
// in. These tests pin the text; whether the model obeys it is proved on the
// live companion.
import test from "node:test";
import assert from "node:assert/strict";

import { getZaruInit } from "../src/prompts/index.js";
import { ZARU_CHAT_TOOL } from "../src/mcp/streamable-http.js";

const GOAL_CANCEL = "aegis.goal.cancel";

/** The sentence the three goal-making modes' prompts carry, word for word. */
const STOP_SENTENCE =
  "When the person asks you to stop, call aegis.goal.cancel at once: it stops the work and every run still going for it, and nothing starts again for it. Then say in one sentence that the work has stopped.";

const inits = {
  agentic: () => getZaruInit("agentic"),
  execute: () => getZaruInit("execute"),
  workflow: () => getZaruInit("workflow"),
  operator: () => getZaruInit("operator", new Set(), undefined, { isOperator: true, tier: "operator" }),
};

test("U33: the agentic, execute, workflow and operator lists hold aegis.goal.cancel", () => {
  const missing = Object.entries(inits)
    .filter(([, init]) => !init()!.available_tools.includes(GOAL_CANCEL))
    .map(([mode]) => mode);
  assert.deepEqual(missing, [], `the ${missing.join(", ")} list lacks aegis.goal.cancel`);
});

test("U33: the agentic, workflow and execute prompts name aegis.goal.cancel as the answer to stop", () => {
  const missing = (["agentic", "workflow", "execute"] as const).filter(
    (mode) => inits[mode]()!.system_prompt.split(STOP_SENTENCE).length !== 2,
  );
  assert.deepEqual(
    missing,
    [],
    `the ${missing.join(", ")} prompt does not carry the stop sentence once`,
  );
});

test("U33: modes that set no goal neither list nor name aegis.goal.cancel", () => {
  for (const [mode, init] of [
    ["chat", () => getZaruInit("chat")],
    ["live", () => getZaruInit("live", new Set(["live"]), "browser")],
    ["vibecode", () => getZaruInit("vibecode", new Set(["vibecode"]), "browser")],
  ] as const) {
    const result = init()!;
    assert.ok(!result.available_tools.includes(GOAL_CANCEL), `${mode} lists aegis.goal.cancel`);
    assert.ok(!result.system_prompt.includes(GOAL_CANCEL), `${mode} names aegis.goal.cancel`);
  }
});

test("U33: zaru.chat's description names aegis.goal.cancel and every state a goal ends in", () => {
  const description = ZARU_CHAT_TOOL.description;
  const missing = ["met", "cannot_be_met", "exhausted", "expired", "superseded", "stopped", "cancelled"].filter(
    (state) => !description.includes(state),
  );
  assert.deepEqual(missing, [], `the zaru.chat description omits ${missing.join(", ")}`);
  assert.ok(
    description.includes(GOAL_CANCEL),
    "the zaru.chat description names aegis.goal.cancel as the way to stop the work",
  );
});
