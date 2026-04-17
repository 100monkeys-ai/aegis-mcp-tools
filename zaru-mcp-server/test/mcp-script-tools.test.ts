import test from "node:test";
import assert from "node:assert/strict";

import {
  extractScriptsArray,
  handleZaruScriptTool,
} from "../src/mcp/streamable-http.js";
import type { ZaruUser } from "../src/middleware/auth.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const USER: ZaruUser = {
  userId: "user-1",
  tier: "free",
  securityContext: "zaru-free",
  token: "jwt",
  isOperator: false,
};

interface InvokeCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Build a mock OrchestratorClient that records each `invokeTool` call and
 * returns the next response from `responses` in order.
 */
function mockClient(responses: unknown[]): {
  invokeTool: (
    user: ZaruUser,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  calls: InvokeCall[];
} {
  const calls: InvokeCall[] = [];
  let i = 0;
  return {
    calls,
    invokeTool: async (_user, name, args) => {
      calls.push({ name, args });
      if (i >= responses.length) {
        throw new Error(`mockClient: unexpected invokeTool call #${i + 1}`);
      }
      return responses[i++];
    },
  };
}

// A representative SEAL-gateway envelope for a successful tool call.
// This mirrors the shape returned by `OrchestratorClient.invokeTool`.
function sealTextEnvelope(jsonPayload: unknown): {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(jsonPayload) }],
    isError: false,
  };
}

// ---------------------------------------------------------------------------
// zaru.script.save — thin pass-through to aegis.script.save
// ---------------------------------------------------------------------------

test("zaru.script.save forwards args verbatim to aegis.script.save", async () => {
  const savedDto = {
    id: "01999999-9999-7999-9999-999999999999",
    name: "hello",
    description: "prints hi",
    code: "console.log('hi')",
    tags: [],
    version: 1,
  };
  const client = mockClient([sealTextEnvelope(savedDto)]);
  const args = {
    name: "hello",
    description: "prints hi",
    code: "console.log('hi')",
    tags: ["demo"],
  };

  const result = await handleZaruScriptTool(
    client,
    USER,
    "zaru.script.save",
    args,
  );

  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0]?.name, "aegis.script.save");
  assert.deepEqual(client.calls[0]?.args, args);
  // The SEAL envelope is passed through unchanged to the LLM.
  assert.equal(result.isError, false);
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content[0]?.type, "text");
  assert.match(result.content[0]?.text ?? "", /"id":/);
});

// ---------------------------------------------------------------------------
// zaru.script.run — by id
// ---------------------------------------------------------------------------

test("zaru.script.run with {id} calls aegis.script.get once with that id", async () => {
  const dto = {
    id: "01999999-9999-7999-9999-999999999999",
    name: "hello",
    code: "console.log('hi')",
  };
  const client = mockClient([sealTextEnvelope(dto)]);

  const result = await handleZaruScriptTool(client, USER, "zaru.script.run", {
    id: "01999999-9999-7999-9999-999999999999",
  });

  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0]?.name, "aegis.script.get");
  assert.deepEqual(client.calls[0]?.args, {
    id: "01999999-9999-7999-9999-999999999999",
  });
  assert.equal(result.isError, false);
});

// ---------------------------------------------------------------------------
// zaru.script.run — by name (resolves via aegis.script.list)
// ---------------------------------------------------------------------------

test("zaru.script.run with {name} resolves id via aegis.script.list then fetches via aegis.script.get", async () => {
  const listed = [
    {
      id: "01999999-9999-7999-9999-999999999999",
      name: "hello",
    },
  ];
  const fetched = {
    id: "01999999-9999-7999-9999-999999999999",
    name: "hello",
    code: "console.log('hi')",
  };
  const client = mockClient([
    sealTextEnvelope(listed),
    sealTextEnvelope(fetched),
  ]);

  const result = await handleZaruScriptTool(client, USER, "zaru.script.run", {
    name: "hello",
  });

  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0]?.name, "aegis.script.list");
  assert.deepEqual(client.calls[0]?.args, { q: "hello" });
  assert.equal(client.calls[1]?.name, "aegis.script.get");
  assert.deepEqual(client.calls[1]?.args, {
    id: "01999999-9999-7999-9999-999999999999",
  });
  assert.equal(result.isError, false);
});

// ---------------------------------------------------------------------------
// zaru.script.run — id wins over name when both given
// ---------------------------------------------------------------------------

test("zaru.script.run with both {id, name} prefers id and skips the list step", async () => {
  const dto = {
    id: "01999999-9999-7999-9999-999999999999",
    name: "hello",
    code: "console.log('hi')",
  };
  const client = mockClient([sealTextEnvelope(dto)]);

  await handleZaruScriptTool(client, USER, "zaru.script.run", {
    id: "01999999-9999-7999-9999-999999999999",
    name: "hello",
  });

  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0]?.name, "aegis.script.get");
});

// ---------------------------------------------------------------------------
// zaru.script.run — missing input
// ---------------------------------------------------------------------------

test("zaru.script.run with neither id nor name returns an error result and makes no calls", async () => {
  const client = mockClient([]);
  const result = await handleZaruScriptTool(
    client,
    USER,
    "zaru.script.run",
    {},
  );

  assert.equal(client.calls.length, 0);
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /requires either 'id' or 'name'/);
});

// ---------------------------------------------------------------------------
// zaru.script.run — name matches zero scripts
// ---------------------------------------------------------------------------

test("zaru.script.run with a name that matches no scripts returns a 'no script named' error", async () => {
  const client = mockClient([sealTextEnvelope([])]);

  const result = await handleZaruScriptTool(client, USER, "zaru.script.run", {
    name: "missing",
  });

  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0]?.name, "aegis.script.list");
  assert.equal(result.isError, true);
  assert.match(
    result.content[0]?.text ?? "",
    /No saved script named "missing"/,
  );
});

// ---------------------------------------------------------------------------
// zaru.script.run — name matches multiple scripts
// ---------------------------------------------------------------------------

test("zaru.script.run with a name that matches multiple scripts returns an error listing the ids", async () => {
  const listed = [
    { id: "01111111-1111-7111-1111-111111111111", name: "hello" },
    { id: "02222222-2222-7222-2222-222222222222", name: "Hello" },
  ];
  const client = mockClient([sealTextEnvelope(listed)]);

  const result = await handleZaruScriptTool(client, USER, "zaru.script.run", {
    name: "hello",
  });

  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0]?.name, "aegis.script.list");
  assert.equal(result.isError, true);
  const text = result.content[0]?.text ?? "";
  assert.match(text, /Multiple saved scripts match "hello"/);
  assert.match(text, /01111111-1111-7111-1111-111111111111/);
  assert.match(text, /02222222-2222-7222-2222-222222222222/);
});

// ---------------------------------------------------------------------------
// extractScriptsArray — response-shape tolerance
// ---------------------------------------------------------------------------

test("extractScriptsArray unwraps SEAL text-envelope carrying a JSON array", () => {
  const scripts = [{ id: "a", name: "x" }];
  const envelope = {
    content: [{ type: "text", text: JSON.stringify(scripts) }],
    isError: false,
  };
  assert.deepEqual(extractScriptsArray(envelope), scripts);
});

test("extractScriptsArray unwraps a direct JSON-type envelope", () => {
  const scripts = [{ id: "a", name: "x" }];
  const envelope = {
    content: [{ type: "json", json: scripts }],
  };
  assert.deepEqual(extractScriptsArray(envelope), scripts);
});

test("extractScriptsArray returns a direct array unchanged", () => {
  const scripts = [{ id: "a", name: "x" }];
  assert.deepEqual(extractScriptsArray(scripts), scripts);
});

test("extractScriptsArray returns an empty array for a malformed shape", () => {
  assert.deepEqual(extractScriptsArray({ wrong: true }), []);
  assert.deepEqual(extractScriptsArray(null), []);
  assert.deepEqual(extractScriptsArray("not json"), []);
  assert.deepEqual(
    extractScriptsArray({
      content: [{ type: "text", text: "not valid json {[" }],
    }),
    [],
  );
});
