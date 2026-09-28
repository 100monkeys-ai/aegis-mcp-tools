import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// src/index.ts loads `dotenv/config` before anything else. Standard output
// carries one JSON log object per line (src/logging.ts), which promtail
// ships to Loki, so loading the .env file must print nothing there.
// dotenv 18.0.0 to 18.0.3 print "injected env (N) from .env" on standard
// error at every start; from 18.0.4 `dotenv/config` is quiet by default.

const require = createRequire(import.meta.url);
const dotenvConfig = require.resolve("dotenv/config");

function loadDotenvConfig(withEnvFile: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "zaru-dotenv-"));
  try {
    if (withEnvFile) writeFileSync(join(dir, ".env"), "ZARU_DOTENV_TEST=1\n");
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("DOTENV_")) delete env[key];
    }
    const result = spawnSync(
      process.execPath,
      ["-e", `require(${JSON.stringify(dotenvConfig)}); console.error("loaded=" + process.env.ZARU_DOTENV_TEST)`],
      { cwd: dir, env, encoding: "utf8" },
    );
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loading dotenv/config writes nothing to standard output", () => {
  for (const withEnvFile of [true, false]) {
    const result = loadDotenvConfig(withEnvFile);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "", `standard output with .env=${withEnvFile}`);
  }
});

test("loading dotenv/config reads the .env file and prints no banner", () => {
  const result = loadDotenvConfig(true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "loaded=1\n");
});
