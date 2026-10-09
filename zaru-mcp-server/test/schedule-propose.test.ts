// `zaru.schedule`: a schedule proposed to the person as a card (AEGIS ADR-139
// N17, the server half). The tool is listed to every caller beside
// `zaru.mode`, creates nothing and records nothing; it checks the proposal's
// shape against N2's bounds, then (N18) that its target is one of the
// person's own agents or workflows, read by the orchestrator's listing under
// the person's session, and answers the model one short text, with the
// proposal echoed in the result's structured content for Zaru Web's card.
//
// The served surface is read the way a client reads it: tools/list and
// tools/call through `createMcpServerForUser` over the SDK's in-memory
// transport, its orchestrator a stub behind the real client's fetch. The
// `at` bounds depend on the time of the call, so they are tested through the
// exported validator with a fixed `now`.
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

/** One agent and one workflow, in the shape the orchestrator's listings answer. */
const AGENT = { id: "7d3c2a51-0b6e-4c1f-9a8e-2f4b6c8d0e1a", name: "mail-watcher" };
const WORKFLOW = { id: "c1e2d3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f", name: "lease-follow-up" };

type Listing = (tool: string) => Response;

const LISTED: Listing = (tool) =>
  tool === "aegis.agent.list"
    ? json({ tool, count: 1, agents: [{ ...AGENT, version: "1.0.0", status: "deployed" }] })
    : json({ tool, count: 1, workflows: [{ ...WORKFLOW, version: "1.0.0", scope: "tenant" }] });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** What reached the orchestrator: every request, and each tool called by name. */
interface Seen {
  requests: string[];
  tools: string[];
  bearer: string[];
}

/**
 * The real orchestrator client over a stub fetch: the attestation answers a
 * session, the catalogue is empty, and each tools/call is answered by
 * `listing` with the tool it names.
 */
function orchestratorStub(seen: Seen, listing: Listing): OrchestratorClient {
  return new OrchestratorClient({
    baseUrl: "http://orchestrator.invalid",
    fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.requests.push(url);
      if (url.endsWith("/v1/seal/attest")) {
        seen.bearer.push(String((init?.headers as Record<string, string>)?.Authorization));
        return json({ security_token: "tok" });
      }
      // tools/list reads the orchestrator's catalogue; this server's own tools follow it.
      if (!url.endsWith("/v1/seal/invoke")) return json([]);
      const envelope = JSON.parse(String(init?.body)) as { payload: { params: { name: string } } };
      seen.tools.push(envelope.payload.params.name);
      return listing(envelope.payload.params.name);
    },
  });
}

async function connected(
  seen: Seen = { requests: [], tools: [], bearer: [] },
  listing: Listing = LISTED,
): Promise<Client> {
  const server = createMcpServerForUser(USER, new Set(), "schedule-propose", orchestratorStub(seen, listing));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "schedule-propose", version: "0" });
  await client.connect(clientSide);
  return client;
}

const RECURRING = {
  target_kind: "agent",
  target: AGENT.name,
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

test("N17, N18: a proposal answers that the card was shown and echoes itself as structured content, after the agent listing alone", async () => {
  const seen: Seen = { requests: [], tools: [], bearer: [] };
  const client = await connected(seen);
  try {
    const result = await client.callTool({ name: "zaru.schedule", arguments: RECURRING });
    assert.equal(result.isError, false);
    assert.deepEqual(result.content, [{ type: "text", text: SCHEDULE_PROPOSAL_ANSWER }]);
    assert.equal(SCHEDULE_PROPOSAL_ANSWER, "A Schedule this card was shown to the person; the turn ends here.");
    assert.deepEqual(result.structuredContent, { action: "schedule_proposed", ...RECURRING });
    assert.deepEqual(seen.tools, ["aegis.agent.list"], "a proposal reaches the orchestrator for its listing alone");
    assert.deepEqual(seen.bearer, [`Bearer ${USER.token}`], "the listing is read under the person's own session");
  } finally {
    await client.close();
  }
});

test("N17: a recurrence without a time zone or jitter is echoed with N2's defaults", async () => {
  const client = await connected();
  try {
    const result = await client.callTool({
      name: "zaru.schedule",
      arguments: { ...RECURRING, recurrence: { cron: "0 9 * * 1-5" } },
    });
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, {
      action: "schedule_proposed",
      ...RECURRING,
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
  const seen: Seen = { requests: [], tools: [], bearer: [] };
  const client = await connected(seen);
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
  if (seen.requests.length) failures.push(`a proposal refused on its shape reached the orchestrator: ${seen.requests.join(", ")}`);
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

// ---------------------------------------------------------------------------
// AEGIS ADR-139 N18: a proposal names an agent or workflow of the person's
// that exists. After the shape checks pass, the server reads the person's own
// listing of the target's kind, under the person's session, and refuses with
// no card a target that matches no entry's name or id exactly, or any target
// when the listing cannot be read.
// ---------------------------------------------------------------------------

const EMPTY_TARGET =
  "'target' must name one of your agents or workflows. Find or make the one that does this, run it once, then propose the schedule naming it.";
const NO_AGENT = (target: string) =>
  `You have no agent named '${target}'. Find or make the one that does this, run it once, then propose the schedule naming it.`;
const NO_WORKFLOW = (target: string) =>
  `You have no workflow named '${target}'. Find or make the one that does this, run it once, then propose the schedule naming it.`;
const UNREADABLE = "Your agents and workflows could not be read just now, so nothing was proposed.";

/** The refusal's sentence, or what came back instead of a refusal. */
function refusalOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const text = (result.content as Array<{ text: string }>)[0]?.text;
  if (result.isError !== true || result.structuredContent !== undefined) return `not refused: ${JSON.stringify(result)}`;
  try {
    return (JSON.parse(text) as { error: string }).error;
  } catch {
    return `not a refusal: ${text}`;
  }
}

test("N18: the schema describes 'target' as one of the person's agents or workflows that already exists", async () => {
  const client = await connected();
  try {
    const { tools } = await client.listTools();
    const schema = tools.find((tool) => tool.name === "zaru.schedule")?.inputSchema as {
      properties: Record<string, { description?: string }>;
    };
    assert.equal(
      schema.properties.target?.description,
      "The name of one of the person's agents or workflows that does this. It must already exist.",
    );
  } finally {
    await client.close();
  }
});

test("N18: an empty or blank target, or one that is not a string, is refused with its sentence before any listing", async () => {
  const failures: string[] = [];
  const seen: Seen = { requests: [], tools: [], bearer: [] };
  const client = await connected(seen);
  try {
    for (const target of ["", "   ", 7]) {
      for (const target_kind of ["agent", "workflow"]) {
        const sentence = refusalOf(await client.callTool({ name: "zaru.schedule", arguments: { ...RECURRING, target_kind, target } }));
        if (sentence !== EMPTY_TARGET) failures.push(`${target_kind} ${JSON.stringify(target)}: ${sentence}`);
      }
    }
  } finally {
    await client.close();
  }
  if (seen.requests.length) failures.push(`an empty target reached the orchestrator: ${seen.requests.join(", ")}`);
  assert.deepEqual(failures, [], failures.join("; "));
});

test("N18: an unknown agent and an unknown workflow are refused with their sentences, each after one listing of its own kind", async () => {
  const failures: string[] = [];
  const cases: Array<[string, string, string, string]> = [
    ["agent", "inbox-watcher", "aegis.agent.list", NO_AGENT("inbox-watcher")],
    // A workflow's name is not an agent's, and an agent's is not a workflow's.
    ["agent", WORKFLOW.name, "aegis.agent.list", NO_AGENT(WORKFLOW.name)],
    ["workflow", "inbox-follow-up", "aegis.workflow.list", NO_WORKFLOW("inbox-follow-up")],
    ["workflow", AGENT.name, "aegis.workflow.list", NO_WORKFLOW(AGENT.name)],
    // The match is exact: no other case, no surrounding space.
    ["agent", AGENT.name.toUpperCase(), "aegis.agent.list", NO_AGENT(AGENT.name.toUpperCase())],
    ["agent", ` ${AGENT.name}`, "aegis.agent.list", NO_AGENT(` ${AGENT.name}`)],
    ["workflow", WORKFLOW.id.toUpperCase(), "aegis.workflow.list", NO_WORKFLOW(WORKFLOW.id.toUpperCase())],
  ];
  for (const [target_kind, target, listing, expected] of cases) {
    const seen: Seen = { requests: [], tools: [], bearer: [] };
    const client = await connected(seen);
    try {
      const sentence = refusalOf(await client.callTool({ name: "zaru.schedule", arguments: { ...RECURRING, target_kind, target } }));
      if (sentence !== expected) failures.push(`${target_kind} ${JSON.stringify(target)}: ${sentence}`);
      if (!isDeepStrictEqual(seen.tools, [listing])) failures.push(`${target_kind} ${JSON.stringify(target)}: called ${JSON.stringify(seen.tools)}, not [${listing}]`);
    } finally {
      await client.close();
    }
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("N18: a listing that fails, or answers no list, refuses the proposal with its sentence", async () => {
  const failures: string[] = [];
  const cases: Array<[string, Listing]> = [
    ["a 503", () => json({ error: "unavailable", message: "The orchestrator is not ready." }, 503)],
    ["a 403", () => json({ error: "tool_not_allowed", message: "Not in your security context." }, 403)],
    ["an answer that is not a list", (tool) => json({ tool, error: "Workflow repository not configured" })],
    ["a list under the other kind's key", (tool) => json({ tool, count: 1, items: [AGENT, WORKFLOW] })],
    ["a network failure", () => { throw new TypeError("fetch failed"); }],
  ];
  for (const [name, listing] of cases) {
    for (const [target_kind, target] of [["agent", AGENT.name], ["workflow", WORKFLOW.name]]) {
      const client = await connected(undefined, listing);
      try {
        const sentence = refusalOf(await client.callTool({ name: "zaru.schedule", arguments: { ...RECURRING, target_kind, target } }));
        if (sentence !== UNREADABLE) failures.push(`${name}, ${target_kind}: ${sentence}`);
      } finally {
        await client.close();
      }
    }
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("N18: an agent is accepted by its name and by its id, a workflow by its name and by its id, each answering the card", async () => {
  const failures: string[] = [];
  const cases: Array<[string, string, string]> = [
    ["agent", AGENT.name, "aegis.agent.list"],
    ["agent", AGENT.id, "aegis.agent.list"],
    ["workflow", WORKFLOW.name, "aegis.workflow.list"],
    ["workflow", WORKFLOW.id, "aegis.workflow.list"],
  ];
  for (const [target_kind, target, listing] of cases) {
    const seen: Seen = { requests: [], tools: [], bearer: [] };
    const client = await connected(seen);
    try {
      const result = await client.callTool({ name: "zaru.schedule", arguments: { ...RECURRING, target_kind, target } });
      const expected = { action: "schedule_proposed", ...RECURRING, target_kind, target };
      if (result.isError !== false || !isDeepStrictEqual(result.structuredContent, expected))
        failures.push(`${target_kind} ${target}: answered ${JSON.stringify(result)}`);
      if (!isDeepStrictEqual(seen.tools, [listing])) failures.push(`${target_kind} ${target}: called ${JSON.stringify(seen.tools)}`);
    } finally {
      await client.close();
    }
  }
  assert.deepEqual(failures, [], failures.join("; "));
});
