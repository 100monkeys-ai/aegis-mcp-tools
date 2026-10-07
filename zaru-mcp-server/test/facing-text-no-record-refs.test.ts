// No text a person or a model receives from this server names a decision
// record (AEGIS ADR-134 D1 and D3, Zaru ADR-0056: the same decision).
//
// The facing text is what the server serves, read the way a client reads it:
// `tools/list` through `createMcpServerForUser` over the SDK's in-memory
// transport, for a JWT user, a JWT operator, an API key (which lists
// zaru.operator.escalate) and an escalated API key (which lists
// zaru.operator.release), each with and without the capabilities that change
// the mode enum, and with and without the Worker's wait ceiling (which adds a
// sentence to every `.wait` tool); the server's instructions; and every mode's
// system prompt as `zaru.init` and `zaru.mode` build it (`getZaruInit`, then
// the empty-memory section), with no context chosen and with every context
// sentence taught. Beside that, the edge-fleet descriptors are read
// from their module directly: nothing in this repository serves them, and the
// published package may. Code comments are not facing text and keep their
// references.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { edgeFleetToolDescriptors } from "../src/descriptors/index.js";
import type { ZaruUser } from "../src/middleware/auth.js";
import { OrchestratorClient } from "../src/mcp/orchestrator-client.js";
import { createMcpServerForUser } from "../src/mcp/streamable-http.js";
import {
  appendMemoryToSystemPrompt,
  getZaruInit,
} from "../src/prompts/index.js";

const RECORD_REFERENCE =
  /ADR-[0-9]|CD-[0-9]|ADR [0-9]|[Dd]ecision record|security audit 0|audit 0[0-9][0-9]|§[0-9]/;

type Hits = Map<string, string[]>;

function scan(hits: Hits, where: string, text: unknown): void {
  if (typeof text !== "string") return;
  for (const line of text.split("\n")) {
    if (!RECORD_REFERENCE.test(line)) continue;
    const key = line.trim();
    hits.set(key, [...(hits.get(key) ?? []), where]);
  }
}

function scanSchema(hits: Hits, where: string, node: unknown): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => scanSchema(hits, `${where}[${i}]`, child));
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "description" || key === "title") scan(hits, `${where}.${key}`, value);
    else scanSchema(hits, `${where}.${key}`, value);
  }
}

function scanTool(
  hits: Hits,
  where: string,
  tool: { name: string; description?: string; inputSchema?: unknown },
): void {
  scan(hits, `${where} ${tool.name} name`, tool.name);
  scan(hits, `${where} ${tool.name} description`, tool.description);
  scanSchema(hits, `${where} ${tool.name} inputSchema`, tool.inputSchema);
}

/** Every hit, all of them, then fail once: one red names every string. */
function assertNoHits(hits: Hits): void {
  if (hits.size === 0) return;
  const report = [...hits.entries()]
    .map(([line, wheres]) => `  ${line}\n    served at ${wheres.length} place(s), first ${wheres[0]}`)
    .join("\n");
  assert.fail(
    `${hits.size} facing string(s) name a decision record:\n${report}`,
  );
}

const USERS: Record<string, ZaruUser> = {
  jwt_user: { userId: "u-1", tier: "free", securityContext: "ctx-1", token: "a.b.c", isOperator: false },
  jwt_operator: { userId: "u-2", tier: "operator", securityContext: "ctx-2", token: "a.b.c", isOperator: true },
  api_key: { userId: "u-3", tier: "pro", securityContext: "ctx-3", token: "aegis_key", isOperator: false },
  api_key_escalated: {
    userId: "u-4",
    tier: "operator",
    securityContext: "ctx-4",
    token: "aegis_key_escalated",
    isOperator: true,
    operatorEscalation: { expiresAt: "2099-01-01T00:00:00Z" },
  },
};

const CAPABILITY_SETS: string[][] = [[], ["live", "vibecode", "chat-uploads"]];

/** Discovery answers one wait tool and one other, both clean. */
const DISCOVERED = [
  { name: "aegis.task.wait", description: "Wait for a task.", inputSchema: { type: "object", properties: {} } },
  { name: "aegis.stub.echo", description: "Echo.", inputSchema: { type: "object", properties: {} } },
];

test("facing text: tools/list and the server's instructions name no decision record", async () => {
  const hits: Hits = new Map();
  const listed = new Set<string>();
  for (const [userName, user] of Object.entries(USERS)) {
    for (const capabilities of CAPABILITY_SETS) {
      for (const waitCeilingSeconds of [null, 45]) {
        const orchestrator = new OrchestratorClient({
          baseUrl: "http://orchestrator.invalid",
          fetchImpl: async () =>
            new Response(JSON.stringify(DISCOVERED), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          waitCeilingSeconds,
        });
        const server = createMcpServerForUser(user, new Set(capabilities), "facing-text", orchestrator);
        const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
        await server.connect(serverSide);
        const client = new Client({ name: "facing-text", version: "0" });
        await client.connect(clientSide);
        try {
          const where = `tools/list[${userName}, capabilities=${capabilities.join("+") || "none"}, wait ceiling=${waitCeilingSeconds}]`;
          scan(hits, `${where} instructions`, client.getInstructions());
          const { tools } = await client.listTools();
          for (const tool of tools) {
            listed.add(tool.name);
            scanTool(hits, where, tool);
          }
        } finally {
          await client.close();
        }
      }
    }
  }
  // The variants reached the surfaces they exist for.
  for (const name of ["zaru.init", "zaru.mode", "zaru.chat", "zaru.operator.escalate", "zaru.operator.release", "aegis.task.wait"]) {
    assert.ok(listed.has(name), `${name} was listed for some caller`);
  }
  assertNoHits(hits);
});

test("facing text: the edge-fleet descriptors name no decision record", () => {
  const hits: Hits = new Map();
  assert.ok(edgeFleetToolDescriptors.length > 0);
  for (const tool of edgeFleetToolDescriptors) scanTool(hits, "descriptors/edge-fleet", tool);
  assertNoHits(hits);
});

test("facing text: every mode's system prompt names no decision record", () => {
  const hits: Hits = new Map();
  const operator = { isOperator: true, tier: "operator" };
  const inits: Array<[string, ReturnType<typeof getZaruInit>]> = [
    ["chat", getZaruInit("chat")],
    ["chat+chat-uploads", getZaruInit("chat", new Set(["chat-uploads"]))],
    ["agentic", getZaruInit("agentic")],
    ["agentic+chat-uploads", getZaruInit("agentic", new Set(["chat-uploads"]))],
    ["workflow", getZaruInit("workflow")],
    ["workflow+chat-uploads", getZaruInit("workflow", new Set(["chat-uploads"]))],
    ["execute", getZaruInit("execute")],
    ["live", getZaruInit("live", new Set(["live"]), "browser")],
    ["vibecode", getZaruInit("vibecode", new Set(["vibecode"]), "browser")],
    ["operator", getZaruInit("operator", new Set(), undefined, operator)],
  ];
  // With every context sentence taught: Nuclear Notes', GitHub's, the generic
  // one, and the several-of-one-kind sentence.
  const contexts = {
    "nuclear-notes": ["3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c", "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"],
    github: ["0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"],
    imap: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
  };
  for (const [mode, caps, runtime] of [
    ["chat", new Set<string>(), undefined],
    ["agentic", new Set(["chat-uploads"]), undefined],
    ["workflow", new Set<string>(), undefined],
    ["execute", new Set<string>(), undefined],
    ["live", new Set(["live"]), "browser"],
    ["vibecode", new Set(["vibecode"]), "browser"],
    ["operator", new Set<string>(), undefined],
  ] as const) {
    inits.push([`${mode}+contexts`, getZaruInit(mode, caps, runtime, operator, contexts)]);
  }
  for (const [mode, init] of inits) {
    assert.ok(init, `getZaruInit answers ${mode}`);
    const prompt = appendMemoryToSystemPrompt(init.system_prompt, { content: "" });
    scan(hits, `zaru.init[${mode}] system_prompt`, prompt);
  }
  assertNoHits(hits);
});
