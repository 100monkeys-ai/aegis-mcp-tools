import test from "node:test";
import assert from "node:assert/strict";

import { getZaruInit, ZARU_VERSION } from "../src/prompts/index.js";

// ---------------------------------------------------------------------------
// vibecode mode — capability gate
// ---------------------------------------------------------------------------

test("getZaruInit('vibecode') returns a full response for a browser client with the 'vibecode' capability", () => {
  const result = getZaruInit("vibecode", {
    runtime: "browser",
    capabilities: ["vibecode"],
  });

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
  const result = getZaruInit("vibecode", {
    runtime: "browser",
    capabilities: [],
  });
  assert.equal(result, null);
});

test("getZaruInit('vibecode') returns null for a non-browser client even with the 'vibecode' capability", () => {
  const result = getZaruInit("vibecode", {
    runtime: "cli",
    capabilities: ["vibecode"],
  });
  assert.equal(result, null);
});

test("getZaruInit('vibecode') returns null when a browser client only advertises the 'live' capability", () => {
  const result = getZaruInit("vibecode", {
    runtime: "browser",
    capabilities: ["live"],
  });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// live mode — symmetric capability-gate coverage
// ---------------------------------------------------------------------------

test("getZaruInit('live') returns a full response for a browser client with the 'live' capability", () => {
  const result = getZaruInit("live", {
    runtime: "browser",
    capabilities: ["live"],
  });

  assert.notEqual(result, null);
  assert.equal(result!.mode, "live");
  assert.equal(result!.version, ZARU_VERSION);
  assert.ok(result!.system_prompt.length > 0);
  assert.deepEqual(result!.available_tools, [
    "zaru.mode",
    "zaru.docs",
    "zaru.execute_typescript",
    "zaru.script.save",
    "zaru.script.run",
  ]);
});

test("getZaruInit('live') returns null when the 'live' capability is missing", () => {
  assert.equal(getZaruInit("live"), null);
  assert.equal(
    getZaruInit("live", { runtime: "browser", capabilities: [] }),
    null,
  );
  assert.equal(
    getZaruInit("live", { runtime: "cli", capabilities: ["live"] }),
    null,
  );
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
