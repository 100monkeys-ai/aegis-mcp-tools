import test from "node:test";
import assert from "node:assert/strict";

import {
  handleZaruMemoryGet,
  handleZaruMemorySet,
  injectMemoryIntoInit,
} from "../src/mcp/streamable-http.js";
import {
  VersionConflictError,
  type ZaruMemoryRecord,
} from "../src/clients/zaru-client.js";
import type { ZaruUser } from "../src/middleware/auth.js";

// ---------------------------------------------------------------------------
// Test fixtures — mirrors test/zaru-client.test.ts
// ---------------------------------------------------------------------------

const USER: ZaruUser = {
  userId: "user-1",
  tier: "free",
  securityContext: "zaru-free",
  token: "jwt-token-abc",
  isOperator: false,
};

const RECORD: ZaruMemoryRecord = {
  content: "User prefers concise replies.",
  version: 3,
  updated_at: "2026-04-25T10:00:00Z",
};

interface CapturedLog {
  level: "warn" | "error";
  args: unknown[];
}

function captureLogger(): {
  logger: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  logs: CapturedLog[];
} {
  const logs: CapturedLog[] = [];
  return {
    logs,
    logger: {
      warn: (...args) => logs.push({ level: "warn", args }),
      error: (...args) => logs.push({ level: "error", args }),
    },
  };
}

// ---------------------------------------------------------------------------
// injectMemoryIntoInit
// ---------------------------------------------------------------------------

test("injectMemoryIntoInit: appends memory under the heading on success", async () => {
  const fakeClient = {
    getMemory: async () => RECORD,
  };
  const init = { system_prompt: "BASE PROMPT", mode: "chat" };
  const result = await injectMemoryIntoInit(fakeClient, USER, init);

  assert.equal(result.mode, "chat");
  assert.match(result.system_prompt, /^BASE PROMPT/);
  assert.match(result.system_prompt, /## Your Memory About This User/);
  assert.match(result.system_prompt, /User prefers concise replies\./);
});

test("injectMemoryIntoInit: empty memory content yields the empty-memory stub via appendMemoryToSystemPrompt", async () => {
  const fakeClient = {
    getMemory: async (): Promise<ZaruMemoryRecord> => ({
      content: "",
      version: 1,
      updated_at: "2026-04-25T00:00:00Z",
    }),
  };
  const init = { system_prompt: "BASE" };
  const result = await injectMemoryIntoInit(fakeClient, USER, init);

  assert.match(result.system_prompt, /## Your Memory About This User/);
  assert.match(
    result.system_prompt,
    /No memory yet — use zaru\.memory\.set to start building it/,
  );
});

test("injectMemoryIntoInit: client error returns init unchanged and logs a warning", async () => {
  const fakeClient = {
    getMemory: async (): Promise<ZaruMemoryRecord> => {
      throw new Error("zaru-client unreachable");
    },
  };
  const { logger, logs } = captureLogger();
  const init = { system_prompt: "BASE", extra: 42 };
  const result = await injectMemoryIntoInit(fakeClient, USER, init, logger);

  // Same object identity — function returns input on failure.
  assert.equal(result, init);
  assert.equal(result.system_prompt, "BASE");
  assert.equal(result.extra, 42);

  // Warning was logged with the underlying error message.
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.level, "warn");
  const joined = logs[0]!.args.map(String).join(" ");
  assert.match(joined, /failed to fetch Zaru User Memory/);
  assert.match(joined, /zaru-client unreachable/);
});

test("injectMemoryIntoInit: does not mutate the input init object on success", async () => {
  const fakeClient = { getMemory: async () => RECORD };
  const init = { system_prompt: "BASE", mode: "agentic" };
  const before = { ...init };
  const result = await injectMemoryIntoInit(fakeClient, USER, init);

  // Input is untouched.
  assert.deepEqual(init, before);
  // Result is a different object with an extended prompt.
  assert.notEqual(result, init);
  assert.notEqual(result.system_prompt, init.system_prompt);
});

// ---------------------------------------------------------------------------
// handleZaruMemoryGet
// ---------------------------------------------------------------------------

test("handleZaruMemoryGet: success wraps record via normalizeToolResult", async () => {
  const fakeClient = { getMemory: async () => RECORD };
  const result = await handleZaruMemoryGet(fakeClient, USER);

  assert.equal(result.isError, false);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]!.type, "text");
  // normalizeToolResult JSON-stringifies non-envelope payloads with 2-space indent.
  const parsed = JSON.parse(result.content[0]!.text);
  assert.deepEqual(parsed, RECORD);
});

test("handleZaruMemoryGet: error returns structured tool error and logs", async () => {
  const fakeClient = {
    getMemory: async (): Promise<ZaruMemoryRecord> => {
      throw new Error("upstream blew up");
    },
  };
  const { logger, logs } = captureLogger();
  const result = await handleZaruMemoryGet(fakeClient, USER, logger);

  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
  const parsed = JSON.parse(result.content[0]!.text);
  assert.equal(parsed.error, "upstream blew up");

  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.level, "error");
});

test("handleZaruMemoryGet: non-Error throw still produces structured error with fallback message", async () => {
  const fakeClient = {
    getMemory: async (): Promise<ZaruMemoryRecord> => {
      throw "string error";
    },
  };
  const { logger } = captureLogger();
  const result = await handleZaruMemoryGet(fakeClient, USER, logger);

  assert.equal(result.isError, true);
  const parsed = JSON.parse(result.content[0]!.text);
  assert.equal(parsed.error, "zaru.memory.get failed");
});

// ---------------------------------------------------------------------------
// handleZaruMemorySet
// ---------------------------------------------------------------------------

test("handleZaruMemorySet: happy path forwards (user, content, version) and wraps result", async () => {
  const calls: Array<{ user: ZaruUser; content: string; version: number }> = [];
  const updated: ZaruMemoryRecord = {
    content: "new content",
    version: 4,
    updated_at: "2026-04-25T11:00:00Z",
  };
  const fakeClient = {
    setMemory: async (user: ZaruUser, content: string, version: number) => {
      calls.push({ user, content, version });
      return updated;
    },
  };

  const result = await handleZaruMemorySet(fakeClient, USER, {
    content: "new content",
    version: 3,
  });

  assert.equal(result.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.user, USER);
  assert.equal(calls[0]!.content, "new content");
  assert.equal(calls[0]!.version, 3);

  const parsed = JSON.parse(result.content[0]!.text);
  assert.deepEqual(parsed, updated);
});

test("handleZaruMemorySet: missing args produces structured error and does NOT call setMemory", async () => {
  let invoked = false;
  const fakeClient = {
    setMemory: async (): Promise<ZaruMemoryRecord> => {
      invoked = true;
      throw new Error("should not be called");
    },
  };

  // Missing both
  const r1 = await handleZaruMemorySet(fakeClient, USER, {});
  assert.equal(r1.isError, true);
  assert.match(r1.content[0]!.text, /requires both 'content' .* and 'version'/);

  // Missing version
  const r2 = await handleZaruMemorySet(fakeClient, USER, { content: "x" });
  assert.equal(r2.isError, true);

  // Missing content
  const r3 = await handleZaruMemorySet(fakeClient, USER, { version: 1 });
  assert.equal(r3.isError, true);

  // Wrong types
  const r4 = await handleZaruMemorySet(fakeClient, USER, {
    content: 123,
    version: "1",
  });
  assert.equal(r4.isError, true);

  // null args
  const r5 = await handleZaruMemorySet(fakeClient, USER, null);
  assert.equal(r5.isError, true);

  assert.equal(invoked, false);
});

test("handleZaruMemorySet: VersionConflictError returns structured conflict with current, does NOT throw", async () => {
  const current: ZaruMemoryRecord = {
    content: "server-side newer content",
    version: 7,
    updated_at: "2026-04-25T12:00:00Z",
  };
  const fakeClient = {
    setMemory: async (): Promise<ZaruMemoryRecord> => {
      throw new VersionConflictError(current);
    },
  };

  const result = await handleZaruMemorySet(fakeClient, USER, {
    content: "stale",
    version: 3,
  });

  assert.equal(result.isError, true);
  const parsed = JSON.parse(result.content[0]!.text);
  assert.equal(parsed.error, "version_conflict");
  assert.match(parsed.message, /Memory was updated by another writer/);
  assert.deepEqual(parsed.current, current);
});

test("handleZaruMemorySet: generic upstream error produces structured tool error and logs", async () => {
  const fakeClient = {
    setMemory: async (): Promise<ZaruMemoryRecord> => {
      throw new Error("kaboom");
    },
  };
  const { logger, logs } = captureLogger();

  const result = await handleZaruMemorySet(
    fakeClient,
    USER,
    { content: "x", version: 1 },
    logger,
  );

  assert.equal(result.isError, true);
  const parsed = JSON.parse(result.content[0]!.text);
  assert.equal(parsed.error, "kaboom");

  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.level, "error");
});

test("handleZaruMemorySet: non-Error throw produces fallback error message", async () => {
  const fakeClient = {
    setMemory: async (): Promise<ZaruMemoryRecord> => {
      throw "boom-string";
    },
  };
  const { logger } = captureLogger();

  const result = await handleZaruMemorySet(
    fakeClient,
    USER,
    { content: "x", version: 1 },
    logger,
  );

  assert.equal(result.isError, true);
  const parsed = JSON.parse(result.content[0]!.text);
  assert.equal(parsed.error, "zaru.memory.set failed");
});
