// `zaru.schedule`: a schedule proposed to the person as a card (AEGIS ADR-139
// N17, the server half). The tool is listed to every caller beside
// `zaru.mode`, creates nothing and records nothing; it checks the proposal's
// shape against N2's bounds and answers the model one short text, with the
// proposal echoed in the result's structured content for Zaru Web's card.
//
// The served surface is read the way a client reads it: tools/list and
// tools/call through `createMcpServerForUser` over the SDK's in-memory
// transport. The `at` bounds depend on the time of the call, so they are
// tested through the exported validator with a fixed `now`.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { ZaruUser } from "../src/middleware/auth.js";
import { OrchestratorClient } from "../src/mcp/orchestrator-client.js";
import {
  createMcpServerForUser,
  SCHEDULE_PROPOSAL_ANSWER,
  validateScheduleProposal,
} from "../src/mcp/streamable-http.js";

const USER: ZaruUser = {
  userId: "u-1",
  tier: "free",
  securityContext: "ctx-1",
  token: "a.b.c",
  isOperator: false,
};

/** Every orchestrator call is recorded; a proposal must make none beyond the listing. */
function orchestratorStub(calls: string[]): OrchestratorClient {
  return new OrchestratorClient({
    baseUrl: "http://orchestrator.invalid",
    fetchImpl: async (input: string | URL | Request) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
}

async function connected(calls: string[] = []): Promise<Client> {
  const server = createMcpServerForUser(USER, new Set(), "schedule-propose", orchestratorStub(calls));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "schedule-propose", version: "0" });
  await client.connect(clientSide);
  return client;
}

const RECURRING = {
  target_kind: "agent",
  target: "mail-watcher",
  intent: "Tell me when Shai replies to the thread about the lease",
  input: { thread: "lease" },
  recurrence: { cron: "*/30 * * * *", timezone: "Europe/Berlin", jitter_seconds: 60 },
  reason: "I can look at the thread every half hour and tell you when Shai replies.",
};

const ONE_OF = "A schedule takes exactly one of 'at' (one run) or 'recurrence' (a repeating run).";
const CRON_FIELDS = "'cron' must be five fields: minute, hour, day of month, month and day of week.";
const GAP = "A schedule runs at most once every 5 minutes.";
const AT_BOUNDS = "'at' must be a time at least one minute from now and at most a year ahead.";

test("N17: zaru.schedule is listed beside zaru.mode, with the proposal's fields and no other required ones", async () => {
  const client = await connected();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    const at = names.indexOf("zaru.schedule");
    assert.ok(at >= 0, `zaru.schedule is listed, got ${names.join(", ")}`);
    assert.equal(names[at - 1], "zaru.mode", "zaru.schedule is listed right after zaru.mode");
    const schema = tools[at].inputSchema as { properties: Record<string, unknown>; required: string[] };
    assert.deepEqual(
      Object.keys(schema.properties),
      ["target_kind", "target", "intent", "input", "at", "recurrence", "reason"],
    );
    assert.deepEqual(schema.required, ["target_kind", "target", "intent", "input", "reason"]);
  } finally {
    await client.close();
  }
});

test("N17: a proposal answers that the card was shown, echoes itself as structured content, and calls nothing", async () => {
  const calls: string[] = [];
  const client = await connected(calls);
  try {
    const result = await client.callTool({ name: "zaru.schedule", arguments: RECURRING });
    assert.equal(result.isError, false);
    assert.deepEqual(result.content, [{ type: "text", text: SCHEDULE_PROPOSAL_ANSWER }]);
    assert.equal(SCHEDULE_PROPOSAL_ANSWER, "A Schedule this card was shown to the person; the turn ends here.");
    assert.deepEqual(result.structuredContent, { action: "schedule_proposed", ...RECURRING });
    assert.deepEqual(calls, [], "a proposal reaches the orchestrator for nothing");
  } finally {
    await client.close();
  }
});

test("N17: a recurrence without a time zone or jitter is echoed with N2's defaults; an empty target is kept", async () => {
  const client = await connected();
  try {
    const result = await client.callTool({
      name: "zaru.schedule",
      arguments: { ...RECURRING, target: "", recurrence: { cron: "0 9 * * 1-5" } },
    });
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, {
      action: "schedule_proposed",
      ...RECURRING,
      target: "",
      recurrence: { cron: "0 9 * * 1-5", timezone: "UTC", jitter_seconds: 0 },
    });
  } finally {
    await client.close();
  }
});

test("N17: each shape refusal answers its sentence as an error", async () => {
  const { recurrence: _recurrence, ...noTiming } = RECURRING;
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["both at and recurrence", { ...RECURRING, at: "2099-01-01T09:00:00Z" }, ONE_OF],
    ["neither at nor recurrence", noTiming, ONE_OF],
    ["a cron every minute", { ...RECURRING, recurrence: { cron: "* * * * *" } }, GAP],
    ["a cron every two minutes in one hour", { ...RECURRING, recurrence: { cron: "0-10/2 9 * * *" } }, GAP],
    ["a six-field cron", { ...RECURRING, recurrence: { cron: "0 */30 * * * *" } }, CRON_FIELDS],
    ["a cron minute out of range", { ...RECURRING, recurrence: { cron: "61 * * * *" } }, CRON_FIELDS],
    ["an unknown time zone", { ...RECURRING, recurrence: { cron: "0 9 * * *", timezone: "Mars/Olympus" } },
      "'timezone' must be a time zone name such as Europe/Berlin."],
    ["jitter past the cap", { ...RECURRING, recurrence: { cron: "0 9 * * *", jitter_seconds: 3601 } },
      "'jitter_seconds' must be between 0 and 3600."],
    ["a target kind that is neither", { ...RECURRING, target_kind: "intent" }, "'target_kind' must be agent or workflow."],
    ["an input that is not an object", { ...RECURRING, input: ["lease"] }, "'input' must be an object."],
    ["no reason", { ...RECURRING, reason: "" }, "'reason' must be one sentence for the person."],
  ];
  const failures: string[] = [];
  const client = await connected();
  try {
    for (const [name, args, sentence] of cases) {
      const result = await client.callTool({ name: "zaru.schedule", arguments: args });
      const text = (result.content as Array<{ text: string }>)[0]?.text;
      if (result.isError !== true || text !== JSON.stringify({ error: sentence }))
        failures.push(`${name}: answered ${JSON.stringify(result)}, not the refusal "${sentence}"`);
      if (result.structuredContent !== undefined) failures.push(`${name}: a refusal carries structured content`);
    }
  } finally {
    await client.close();
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("N17: 'at' is one RFC 3339 time from one minute to 366 days ahead", () => {
  const now = new Date("2026-10-09T02:00:00Z");
  const once = (at: unknown) => validateScheduleProposal({ ...RECURRING, recurrence: undefined, at }, now);
  const failures: string[] = [];
  for (const at of ["2026-10-09T02:01:00Z", "2026-10-10T09:00:00+02:00", "2027-10-10T02:00:00Z"]) {
    const checked = once(at);
    if (!checked.ok) failures.push(`${at} was refused: ${checked.error}`);
    else if (checked.proposal.at !== at || "recurrence" in checked.proposal)
      failures.push(`${at} was echoed as ${JSON.stringify(checked.proposal)}`);
  }
  for (const at of ["2026-10-09T02:00:59Z", "2026-10-09T01:00:00Z", "2027-10-10T02:00:01Z", "tomorrow", "2026-10-10", 1760000000]) {
    const checked = once(at);
    if (checked.ok || checked.error !== AT_BOUNDS) failures.push(`${String(at)} answered ${JSON.stringify(checked)}`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

// A model may give `input` as one string (the production turn of 2026-10-09
// answered "'input' must be an object." before its retry drew the card). The
// string is carried as `{prompt: <the string>}`, the shape `aegis.task.execute`
// takes for an agent; an object is carried as it is; anything else is refused.
test("N17: a string input is carried as its prompt, an object as it is, and a number is refused", async () => {
  const failures: string[] = [];
  const client = await connected();
  try {
    const { tools } = await client.listTools();
    const schema = tools.find((tool) => tool.name === "zaru.schedule")?.inputSchema as {
      properties: Record<string, { type?: unknown; description?: string }>;
    };
    const typed = schema.properties.input?.type;
    if (!isDeepStrictEqual(typed, ["object", "string"]))
      failures.push(`the schema types input as ${JSON.stringify(typed)}, not ["object","string"]`);
    const described = schema.properties.input?.description;
    const expected =
      "An object of the target's input values, or one string, which is carried as its prompt.";
    if (described !== expected) failures.push(`the schema describes input as ${JSON.stringify(described)}`);

    const cases: Array<[string, unknown, unknown]> = [
      ["a string", "Watch the lease thread for Shai's reply", { prompt: "Watch the lease thread for Shai's reply" }],
      ["an object", { thread: "lease", folder: "INBOX" }, { thread: "lease", folder: "INBOX" }],
    ];
    for (const [name, input, carried] of cases) {
      const result = await client.callTool({ name: "zaru.schedule", arguments: { ...RECURRING, input } });
      const expectedContent = { action: "schedule_proposed", ...RECURRING, input: carried };
      if (result.isError !== false || !isDeepStrictEqual(result.structuredContent, expectedContent))
        failures.push(`${name} input was answered ${JSON.stringify(result)}, not carried as ${JSON.stringify(carried)}`);
    }

    const refused = await client.callTool({ name: "zaru.schedule", arguments: { ...RECURRING, input: 42 } });
    const text = (refused.content as Array<{ text: string }>)[0]?.text;
    if (refused.isError !== true || text !== JSON.stringify({ error: "'input' must be an object." }))
      failures.push(`a number input was answered ${JSON.stringify(refused)}, not refused`);
  } finally {
    await client.close();
  }
  assert.deepEqual(failures, [], failures.join("; "));
});
