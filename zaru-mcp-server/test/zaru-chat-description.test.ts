// zaru.chat's description says what Zaru Web's turn does under Zaru ADR-0049
// D7a: the call answers within the minute an MCP client waits, a turn still
// running at 50 seconds answers status "running" and goes on in Zaru Web, no
// time limit ends a turn outside chat mode, and in chat mode the 40-second
// bound moves the conversation to agentic.
import { test } from "node:test";
import assert from "node:assert/strict";

import { ZARU_CHAT_TOOL } from "../src/mcp/streamable-http.js";

/** D7a's sentence, word for word. */
const TURN_SENTENCE =
  'One call answers within the minute an MCP client waits: a turn still running at 50 seconds returns status "running" and goes on in Zaru Web, its answer stored in the conversation when it ends; outside chat mode no time limit ends a turn, and in chat mode a turn still working at 40 seconds moves the conversation to agentic and goes on there.';

test("D7a: zaru.chat's description carries the turn sentence word for word", () => {
  assert.ok(
    ZARU_CHAT_TOOL.description.includes(TURN_SENTENCE),
    "the zaru.chat description lacks D7a's turn sentence",
  );
});

test("D7a: zaru.chat's description no longer says a turn ends at 50 seconds or is held to five model calls", () => {
  const description = ZARU_CHAT_TOOL.description;
  for (const phrase of [
    "One call runs one turn of at most five model calls",
    "at most five model calls",
    'ends the turn at 50 seconds with status "incomplete"',
    "starts no model call after 40 seconds",
    "everything done so far stored",
  ]) {
    assert.ok(!description.includes(phrase), `still there: ${phrase}`);
  }
});
