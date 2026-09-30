import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// One Node line, declared once.
//
// zaru-mcp-server/.nvmrc holds the Node major version this server is
// built, tested and shipped on. Every other place that names a Node
// version must agree with it, or this test fails:
//
// - the Dockerfile's base image, node:<major>-alpine pinned by digest;
// - every actions/setup-node step in every workflow, which must read
//   .nvmrc and not name a version of its own;
// - engines.node and @types/node in package.json and the lockfile.
//
// CI's Image job checks the other half: that the built image runs that
// Node. Before this test the image ran Node 22, CI tested Node 20, the
// audit ran on Node 22 and the types described Node 25.

const server = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(server, "..");
const read = (file: string) => readFileSync(file, "utf8");

const nvmrc = read(join(server, ".nvmrc"));
const major = nvmrc.trim();
const pkg = JSON.parse(read(join(server, "package.json")));
const lock = JSON.parse(read(join(server, "package-lock.json")));
const exact = new RegExp(`^\\^${major}\\.\\d+\\.\\d+$`);

test(".nvmrc holds a bare major version and nothing else", () => {
  assert.match(nvmrc, /^\d+\n$/);
});

test("the Dockerfile's one stage is node:<major>-alpine, pinned by digest", () => {
  const froms = read(join(server, "Dockerfile"))
    .split(/\r?\n/)
    .filter((l) => /^FROM\s/i.test(l));
  assert.equal(froms.length, 1);
  assert.match(
    froms[0].split(/\s+/)[1],
    new RegExp(`^node:${major}-alpine@sha256:[0-9a-f]{64}$`),
  );
});

test("every setup-node step in every workflow reads .nvmrc", () => {
  const dir = join(repo, ".github/workflows");
  let steps = 0;
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const lines = read(join(dir, file)).split("\n");
    const uses = lines.filter((l) => /uses:\s*actions\/setup-node@/.test(l)).length;
    const reads = lines.filter((l) =>
      /^\s*node-version-file:\s*zaru-mcp-server\/\.nvmrc\s*$/.test(l),
    ).length;
    steps += uses;
    assert.equal(`${file}: ${reads} of ${uses} read .nvmrc`, `${file}: ${uses} of ${uses} read .nvmrc`);
    assert.deepEqual(
      lines.filter((l) => /^\s*node-version:/.test(l)).map((l) => `${file}: ${l.trim()}`),
      [],
    );
  }
  // ci.yml sets up Node twice, deploy.yml twice, npm-publish.yml twice, security.yml once.
  assert.equal(steps, 7);
});

test("engines.node allows this major and no other", () => {
  assert.match(pkg.engines.node, exact);
  assert.equal(lock.packages[""].engines.node, pkg.engines.node);
});

test("@types/node describes this major", () => {
  const range = pkg.devDependencies["@types/node"];
  assert.match(range, exact);
  assert.equal(lock.packages[""].devDependencies["@types/node"], range);
  const resolved: string = lock.packages["node_modules/@types/node"].version;
  assert.equal(resolved.split(".")[0], major);
});
