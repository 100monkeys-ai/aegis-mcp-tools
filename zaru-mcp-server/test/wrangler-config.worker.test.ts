// wrangler.jsonc carries `global_fetch_strictly_public` wherever it sets
// `compatibility_flags`. Without the flag, a global fetch() from this Worker to
// a hostname on a zone of the same account (`ask.myzaru.com`, ZARU_CLIENT_URL)
// "is routed to the zone's origin server, ignoring any Workers mapped to the
// URL" (developers.cloudflare.com/workers/configuration/compatibility-flags/,
// "Global fetch() strictly public"), so Zaru Web on Workers would never be
// reached. The file is read by wrangler's own reader, the one `wrangler deploy`
// uses, so its JSONC (comments, trailing commas) is parsed as the build parses
// it.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { experimental_readRawConfig, unstable_readConfig } from "wrangler";

const FLAG = "global_fetch_strictly_public";
const CONFIG = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

const { rawConfig } = experimental_readRawConfig({ config: CONFIG });
const environments = Object.keys(rawConfig.env ?? {});

test("wrangler.jsonc: the top level's compatibility_flags carries global_fetch_strictly_public", () => {
  assert.ok(Array.isArray(rawConfig.compatibility_flags), "compatibility_flags is set at the top level");
  assert.ok(rawConfig.compatibility_flags.includes(FLAG), `top-level compatibility_flags ${JSON.stringify(rawConfig.compatibility_flags)} lacks ${FLAG}`);
});

test("wrangler.jsonc: every environment block that sets compatibility_flags carries global_fetch_strictly_public", () => {
  assert.deepEqual(environments.sort(), ["production", "staging"]);
  for (const name of environments) {
    const block = rawConfig.env?.[name] as { compatibility_flags?: string[] } | undefined;
    if (block && Object.hasOwn(block, "compatibility_flags")) {
      assert.ok(block.compatibility_flags?.includes(FLAG), `env.${name}.compatibility_flags ${JSON.stringify(block.compatibility_flags)} lacks ${FLAG}`);
    }
  }
});

test("wrangler.jsonc: each environment, as wrangler resolves it, deploys with global_fetch_strictly_public", () => {
  for (const env of environments) {
    const resolved = unstable_readConfig({ config: CONFIG, env }, { hideWarnings: true });
    assert.ok(resolved.compatibility_flags.includes(FLAG), `--env ${env} resolves compatibility_flags ${JSON.stringify(resolved.compatibility_flags)} without ${FLAG}`);
  }
});
