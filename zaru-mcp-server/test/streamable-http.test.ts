import test from "node:test";
import assert from "node:assert/strict";

import {
  ATTACHMENT_CAPABLE_TOOLS,
  hasAttachments,
  parseCapabilitiesHeader,
  shouldRejectAttachments,
} from "../src/mcp/streamable-http.js";

// ADR-113 chat-uploads defence-in-depth gate.
//
// Regression for the bug where the gate rejected ANY call to an
// attachment-capable tool (`aegis.agent.generate`, `aegis.task.execute`,
// `aegis.execute.intent`) from a session that had not declared the
// `chat-uploads` capability — even when the call carried no attachments.
// This locked external MCP clients out of normal use of those tools and
// also locked the Zaru web client out whenever per-session capability
// state had not yet been recorded for the request.
//
// Correct behaviour: rejection requires ALL of (a) attachment-capable
// tool, (b) payload actually carries a non-empty `attachments` array,
// and (c) the session has not declared `chat-uploads`.

test("ATTACHMENT_CAPABLE_TOOLS contains the three ADR-113 tools", () => {
  assert.ok(ATTACHMENT_CAPABLE_TOOLS.has("aegis.task.execute"));
  assert.ok(ATTACHMENT_CAPABLE_TOOLS.has("aegis.agent.generate"));
  assert.ok(ATTACHMENT_CAPABLE_TOOLS.has("aegis.execute.intent"));
  assert.equal(ATTACHMENT_CAPABLE_TOOLS.size, 3);
});

test("hasAttachments: missing/empty/wrong-shape inputs are all false", () => {
  assert.equal(hasAttachments(undefined), false);
  assert.equal(hasAttachments(null), false);
  assert.equal(hasAttachments({}), false);
  assert.equal(hasAttachments({ attachments: [] }), false);
  assert.equal(hasAttachments({ input: "string-value" }), false);
  assert.equal(hasAttachments({ input: { attachments: [] } }), false);
  assert.equal(hasAttachments({ inputs: { attachments: [] } }), false);
});

test("hasAttachments: top-level non-empty attachments is true", () => {
  assert.equal(
    hasAttachments({ attachments: [{ volume_id: "v", path: "/p" }] }),
    true,
  );
});

test("hasAttachments: nested under `input` non-empty is true", () => {
  assert.equal(
    hasAttachments({
      input: { attachments: [{ volume_id: "v", path: "/p" }] },
    }),
    true,
  );
});

test("hasAttachments: nested under `inputs` non-empty is true", () => {
  assert.equal(
    hasAttachments({
      inputs: { attachments: [{ volume_id: "v", path: "/p" }] },
    }),
    true,
  );
});

// Four-quadrant matrix: (no-attachments | attachments) × (capability | no capability).
// The bug: row 1 was being rejected. Required behaviour: only row 3 rejects.

test("gate: aegis.agent.generate with NO attachments and NO capability — must pass through", () => {
  const args = { input: "A text summarizer agent that writes a brief..." };
  assert.equal(
    shouldRejectAttachments("aegis.agent.generate", args, new Set()),
    false,
  );
});

test("gate: aegis.agent.generate with empty attachments array and NO capability — must pass through", () => {
  const args = { input: "summarize", attachments: [] };
  assert.equal(
    shouldRejectAttachments("aegis.agent.generate", args, new Set()),
    false,
  );
});

test("gate: aegis.agent.generate with NON-empty attachments and NO capability — must reject", () => {
  const args = {
    input: "summarize this",
    attachments: [{ volume_id: "v1", path: "/doc.pdf" }],
  };
  assert.equal(
    shouldRejectAttachments("aegis.agent.generate", args, new Set()),
    true,
  );
});

test("gate: aegis.agent.generate with NON-empty attachments AND chat-uploads capability — must pass through", () => {
  const args = {
    input: "summarize this",
    attachments: [{ volume_id: "v1", path: "/doc.pdf" }],
  };
  assert.equal(
    shouldRejectAttachments(
      "aegis.agent.generate",
      args,
      new Set(["chat-uploads"]),
    ),
    false,
  );
});

test("gate: nested-input attachments are detected and rejected without capability", () => {
  const args = {
    input: { prompt: "go", attachments: [{ volume_id: "v", path: "/p" }] },
  };
  assert.equal(
    shouldRejectAttachments("aegis.task.execute", args, new Set()),
    true,
  );
});

test("gate: aegis.execute.intent without attachments — never rejected, regardless of capability", () => {
  const args = { input: "do the thing" };
  assert.equal(
    shouldRejectAttachments("aegis.execute.intent", args, new Set()),
    false,
  );
  assert.equal(
    shouldRejectAttachments(
      "aegis.execute.intent",
      args,
      new Set(["chat-uploads"]),
    ),
    false,
  );
});

test("gate: tools NOT in the attachment-capable set are never rejected", () => {
  const args = {
    input: "x",
    attachments: [{ volume_id: "v", path: "/p" }],
  };
  // Even with attachments and no capability, a non-capable tool is not gated.
  assert.equal(
    shouldRejectAttachments("aegis.agent.list", args, new Set()),
    false,
  );
  assert.equal(shouldRejectAttachments("zaru.docs", args, new Set()), false);
});

// ─── parseCapabilitiesHeader regression suite ────────────────────────────
//
// Capabilities are sourced from the `X-Zaru-Capabilities` HTTP header on
// every request. This replaces the prior server-side per-session capability
// store. Two prior implementations were both wrong:
//
//   - Stateless mode + per-session McpServer (commit 23b4e21): capabilities
//     declared in zaru.init were discarded between calls.
//   - Stateful mode + in-memory sessions Map (commit b2cf411): capabilities
//     persisted across calls but were wiped on every server restart,
//     breaking every active conversation with -32000 "Server not initialized".
//
// The header design is correct on both axes: every request carries the
// canonical client capability set, and the server holds no state.

test("parseCapabilitiesHeader: undefined / empty / null-ish yields empty set", () => {
  assert.equal(parseCapabilitiesHeader(undefined).size, 0);
  assert.equal(parseCapabilitiesHeader("").size, 0);
  assert.equal(parseCapabilitiesHeader(",").size, 0);
  assert.equal(parseCapabilitiesHeader("   ").size, 0);
});

test("parseCapabilitiesHeader: single value", () => {
  const caps = parseCapabilitiesHeader("chat-uploads");
  assert.equal(caps.size, 1);
  assert.ok(caps.has("chat-uploads"));
});

test("parseCapabilitiesHeader: comma-separated values", () => {
  const caps = parseCapabilitiesHeader("live,vibecode,chat-uploads");
  assert.equal(caps.size, 3);
  assert.ok(caps.has("live"));
  assert.ok(caps.has("vibecode"));
  assert.ok(caps.has("chat-uploads"));
});

test("parseCapabilitiesHeader: trims whitespace and lowercases — canonical form is the only stored form", () => {
  // The canonical form is lowercase, no surrounding whitespace. Inputs that
  // deviate are normalized rather than rejected; this avoids surprising
  // false-negatives from a stray space or differing case in client code.
  const caps = parseCapabilitiesHeader(" Chat-Uploads , LIVE ");
  assert.equal(caps.size, 2);
  assert.ok(caps.has("chat-uploads"));
  assert.ok(caps.has("live"));
});

test("parseCapabilitiesHeader: array form (Express repeated header) is flattened", () => {
  const caps = parseCapabilitiesHeader(["chat-uploads", "live,vibecode"]);
  assert.equal(caps.size, 3);
  assert.ok(caps.has("chat-uploads"));
  assert.ok(caps.has("live"));
  assert.ok(caps.has("vibecode"));
});

test("gate via header: chat-uploads in header passes attachment-bearing aegis.task.execute", () => {
  const caps = parseCapabilitiesHeader("chat-uploads");
  const args = {
    input: "summarize this",
    attachments: [{ volume_id: "v", path: "/doc.pdf" }],
  };
  assert.equal(
    shouldRejectAttachments("aegis.task.execute", args, caps),
    false,
  );
});

test("gate via header: missing X-Zaru-Capabilities REJECTS attachment-bearing aegis.task.execute", () => {
  const caps = parseCapabilitiesHeader(undefined);
  const args = {
    input: "summarize this",
    attachments: [{ volume_id: "v", path: "/doc.pdf" }],
  };
  assert.equal(shouldRejectAttachments("aegis.task.execute", args, caps), true);
});

test("gate via header: live,vibecode WITHOUT chat-uploads REJECTS attachment-bearing call", () => {
  const caps = parseCapabilitiesHeader("live,vibecode");
  const args = {
    input: "summarize this",
    attachments: [{ volume_id: "v", path: "/doc.pdf" }],
  };
  assert.equal(shouldRejectAttachments("aegis.task.execute", args, caps), true);
});

test("gate via header: mixed-case `Chat-Uploads` is normalized and PASSES", () => {
  const caps = parseCapabilitiesHeader("Chat-Uploads");
  const args = {
    input: "summarize this",
    attachments: [{ volume_id: "v", path: "/doc.pdf" }],
  };
  assert.equal(
    shouldRejectAttachments("aegis.task.execute", args, caps),
    false,
  );
});

test("regression for b2cf411: header is read on every request, never stored", () => {
  // Before this fix, capabilities were stored in an in-memory `sessions`
  // Map keyed by Mcp-Session-Id. A server restart wiped that map, so every
  // active chat conversation broke with -32000 "Server not initialized".
  //
  // The contract under test: each request carries its own header, and
  // `parseCapabilitiesHeader` + `shouldRejectAttachments` are pure
  // functions of (header value, tool name, args). No state is shared
  // between calls — simulating two distinct HTTP requests by simply
  // calling the predicate twice with the same header reproduces the
  // exact wire-level behavior across an arbitrary number of requests
  // and across server restarts.
  const args = {
    input: "summarize",
    attachments: [{ volume_id: "v", path: "/doc.pdf" }],
  };
  for (let i = 0; i < 5; i++) {
    const caps = parseCapabilitiesHeader("chat-uploads");
    assert.equal(
      shouldRejectAttachments("aegis.task.execute", args, caps),
      false,
      `request #${i + 1} with header must pass`,
    );
  }
  // And a request without the header on the same "server" must reject —
  // no leaked state from prior requests.
  const capsNo = parseCapabilitiesHeader(undefined);
  assert.equal(
    shouldRejectAttachments("aegis.task.execute", args, capsNo),
    true,
  );
});
