import test from "node:test";
import assert from "node:assert/strict";

import {
  ATTACHMENT_CAPABLE_TOOLS,
  hasAttachments,
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
