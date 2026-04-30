import { strict as assert } from "node:assert";
import { test } from "node:test";

import { allowedModesFor, getZaruInit } from "../src/prompts/index.js";

// ── allowedModesFor ─────────────────────────────────────────────────────────

test("allowedModesFor: free user with no capabilities gets only the four base modes", () => {
  const modes = allowedModesFor({ isOperator: false, tier: "free" }, new Set());
  assert.deepEqual(modes, ["chat", "agentic", "workflow", "execute"]);
});

test("allowedModesFor: 'live' capability adds live but not operator", () => {
  const modes = allowedModesFor(
    { isOperator: false, tier: "free" },
    new Set(["live"]),
  );
  assert.ok(modes.includes("live"));
  assert.ok(!modes.includes("operator"));
});

test("allowedModesFor: 'vibecode' capability adds vibecode but not operator", () => {
  const modes = allowedModesFor(
    { isOperator: false, tier: "free" },
    new Set(["vibecode"]),
  );
  assert.ok(modes.includes("vibecode"));
  assert.ok(!modes.includes("operator"));
});

test("allowedModesFor: isOperator + tier 'operator' includes operator", () => {
  const modes = allowedModesFor(
    { isOperator: true, tier: "operator" },
    new Set(),
  );
  assert.ok(modes.includes("operator"));
});

test("allowedModesFor: isOperator + tier 'admin' includes operator", () => {
  const modes = allowedModesFor({ isOperator: true, tier: "admin" }, new Set());
  assert.ok(modes.includes("operator"));
});

test("allowedModesFor: isOperator=true but tier='free' does NOT include operator (belt-and-suspenders)", () => {
  const modes = allowedModesFor({ isOperator: true, tier: "free" }, new Set());
  assert.ok(!modes.includes("operator"));
});

test("allowedModesFor: tier='operator' but isOperator=false does NOT include operator (belt-and-suspenders)", () => {
  const modes = allowedModesFor(
    { isOperator: false, tier: "operator" },
    new Set(),
  );
  assert.ok(!modes.includes("operator"));
});

// ── getZaruInit operator gate ───────────────────────────────────────────────

test("getZaruInit('operator') returns null for a non-privileged caller", () => {
  const result = getZaruInit("operator", new Set(), undefined, {
    isOperator: false,
    tier: "free",
  });
  assert.equal(result, null);
});

test("getZaruInit('operator') returns null when user is omitted (defaults reject)", () => {
  const result = getZaruInit("operator", new Set(), undefined);
  assert.equal(result, null);
});

test("getZaruInit('operator') returns a populated available_tools for an operator caller", () => {
  const result = getZaruInit("operator", new Set(), undefined, {
    isOperator: true,
    tier: "operator",
  });
  assert.ok(result, "expected non-null result for operator caller");
  assert.equal(result.mode, "operator");
  assert.ok(
    Array.isArray(result.available_tools) && result.available_tools.length > 0,
    "operator available_tools must not be empty",
  );
  // Sanity: destructive admin tools must be present in the operator surface.
  assert.ok(result.available_tools.includes("aegis.agent.delete"));
  assert.ok(result.available_tools.includes("aegis.workflow.delete"));
  assert.ok(result.available_tools.includes("aegis.task.remove"));
});

test("getZaruInit('operator') accepts tier='admin'", () => {
  const result = getZaruInit("operator", new Set(), undefined, {
    isOperator: true,
    tier: "admin",
  });
  assert.ok(result);
  assert.equal(result.mode, "operator");
});

// ── getZaruInit live gate (regression) ──────────────────────────────────────

test("getZaruInit('live') without 'live' capability returns null even when user is provided", () => {
  const result = getZaruInit("live", new Set(), undefined, {
    isOperator: false,
    tier: "free",
  });
  assert.equal(result, null);
});
