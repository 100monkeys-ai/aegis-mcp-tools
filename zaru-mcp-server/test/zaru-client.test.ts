import test from "node:test";
import assert from "node:assert/strict";

import {
  ZaruClient,
  VersionConflictError,
  type ZaruMemoryRecord,
} from "../src/clients/zaru-client.js";
import type { ZaruUser } from "../src/middleware/auth.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const USER: ZaruUser = {
  userId: "user-1",
  tier: "free",
  securityContext: "zaru-free",
  token: "jwt-token-abc",
  isOperator: false,
};

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

/**
 * Build a fetch mock that records every call and returns the next response
 * from `responses` in order.
 */
function recordingFetch(responses: Response[]): {
  fn: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (i >= responses.length) {
      throw new Error(`recordingFetch: unexpected call #${i + 1}`);
    }
    return responses[i++]!;
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// getMemory — happy path
// ---------------------------------------------------------------------------

test("getMemory: GETs /api/zaru-memory with Bearer token and returns parsed JSON", async () => {
  const record: ZaruMemoryRecord = {
    content: "User prefers concise replies.",
    version: 3,
    updated_at: "2026-04-25T10:00:00Z",
  };
  const { fn, calls } = recordingFetch([jsonResponse(record)]);
  const client = new ZaruClient({
    baseUrl: "http://zaru.test:3000",
    fetchImpl: fn,
  });

  const result = await client.getMemory(USER);

  assert.deepEqual(result, record);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://zaru.test:3000/api/zaru-memory");
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.headers.Authorization, "Bearer jwt-token-abc");
  assert.equal(calls[0]!.headers.Accept, "application/json");
});

test("getMemory: throws on non-OK status with status + body in the message", async () => {
  const { fn } = recordingFetch([textResponse("internal boom", 500)]);
  const client = new ZaruClient({
    baseUrl: "http://zaru.test:3000",
    fetchImpl: fn,
  });

  await assert.rejects(
    () => client.getMemory(USER),
    (err: Error) => {
      assert.match(err.message, /getMemory failed/);
      assert.match(err.message, /500/);
      assert.match(err.message, /internal boom/);
      return true;
    },
  );
});

test("getMemory: 404 also throws (any non-OK status, not just 5xx)", async () => {
  const { fn } = recordingFetch([textResponse("not found", 404)]);
  const client = new ZaruClient({
    baseUrl: "http://zaru.test:3000",
    fetchImpl: fn,
  });

  await assert.rejects(() => client.getMemory(USER), /404/);
});

// ---------------------------------------------------------------------------
// setMemory — happy path
// ---------------------------------------------------------------------------

test("setMemory: PUTs JSON body with content+version and returns parsed record", async () => {
  const updated: ZaruMemoryRecord = {
    content: "new content",
    version: 4,
    updated_at: "2026-04-25T11:00:00Z",
  };
  const { fn, calls } = recordingFetch([jsonResponse(updated)]);
  const client = new ZaruClient({
    baseUrl: "http://zaru.test:3000",
    fetchImpl: fn,
  });

  const result = await client.setMemory(USER, "new content", 3);

  assert.deepEqual(result, updated);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://zaru.test:3000/api/zaru-memory");
  assert.equal(calls[0]!.method, "PUT");
  assert.equal(calls[0]!.headers.Authorization, "Bearer jwt-token-abc");
  assert.equal(calls[0]!.headers["Content-Type"], "application/json");
  assert.equal(calls[0]!.headers.Accept, "application/json");
  assert.deepEqual(JSON.parse(calls[0]!.body!), {
    content: "new content",
    version: 3,
  });
});

// ---------------------------------------------------------------------------
// setMemory — 409 version conflict
// ---------------------------------------------------------------------------

test("setMemory: 409 with { current } envelope throws VersionConflictError carrying current", async () => {
  const current: ZaruMemoryRecord = {
    content: "server-side newer content",
    version: 7,
    updated_at: "2026-04-25T12:00:00Z",
  };
  const { fn } = recordingFetch([jsonResponse({ current }, 409)]);
  const client = new ZaruClient({
    baseUrl: "http://zaru.test:3000",
    fetchImpl: fn,
  });

  await assert.rejects(
    () => client.setMemory(USER, "stale", 3),
    (err: unknown) => {
      assert.ok(err instanceof VersionConflictError);
      assert.equal(err.name, "VersionConflictError");
      assert.deepEqual(err.current, current);
      assert.match(err.message, /version 7/);
      return true;
    },
  );
});

test("setMemory: 409 with bare record (no { current } wrapper) is also handled", async () => {
  const current: ZaruMemoryRecord = {
    content: "bare body",
    version: 9,
    updated_at: "2026-04-25T13:00:00Z",
  };
  const { fn } = recordingFetch([jsonResponse(current, 409)]);
  const client = new ZaruClient({
    baseUrl: "http://zaru.test:3000",
    fetchImpl: fn,
  });

  await assert.rejects(
    () => client.setMemory(USER, "stale", 1),
    (err: unknown) => {
      assert.ok(err instanceof VersionConflictError);
      assert.deepEqual(err.current, current);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// setMemory — non-409 errors
// ---------------------------------------------------------------------------

test("setMemory: non-409 error status throws a regular Error (not VersionConflictError)", async () => {
  const { fn } = recordingFetch([textResponse("kaboom", 500)]);
  const client = new ZaruClient({
    baseUrl: "http://zaru.test:3000",
    fetchImpl: fn,
  });

  await assert.rejects(
    () => client.setMemory(USER, "x", 1),
    (err: Error) => {
      assert.ok(!(err instanceof VersionConflictError));
      assert.match(err.message, /setMemory failed/);
      assert.match(err.message, /500/);
      assert.match(err.message, /kaboom/);
      return true;
    },
  );
});

test("setMemory: 401 unauthorized also throws a non-VersionConflictError", async () => {
  const { fn } = recordingFetch([textResponse("nope", 401)]);
  const client = new ZaruClient({
    baseUrl: "http://zaru.test:3000",
    fetchImpl: fn,
  });

  await assert.rejects(
    () => client.setMemory(USER, "x", 1),
    (err: Error) => {
      assert.ok(!(err instanceof VersionConflictError));
      assert.match(err.message, /401/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Network errors propagate (fetch throws)
// ---------------------------------------------------------------------------

test("getMemory: network error from fetch propagates to caller", async () => {
  const fn: typeof fetch = async () => {
    throw new TypeError("network down");
  };
  const client = new ZaruClient({
    baseUrl: "http://zaru.test:3000",
    fetchImpl: fn,
  });

  await assert.rejects(() => client.getMemory(USER), /network down/);
});

test("setMemory: network error from fetch propagates to caller", async () => {
  const fn: typeof fetch = async () => {
    throw new TypeError("network down");
  };
  const client = new ZaruClient({
    baseUrl: "http://zaru.test:3000",
    fetchImpl: fn,
  });

  await assert.rejects(() => client.setMemory(USER, "x", 1), /network down/);
});

// ---------------------------------------------------------------------------
// baseUrl trailing-slash normalization
// ---------------------------------------------------------------------------

test("baseUrl with trailing slash and without produce identical request URLs", async () => {
  const record: ZaruMemoryRecord = {
    content: "x",
    version: 1,
    updated_at: "2026-04-25T00:00:00Z",
  };

  const a = recordingFetch([jsonResponse(record)]);
  const aClient = new ZaruClient({
    baseUrl: "http://zaru.test:3000/",
    fetchImpl: a.fn,
  });
  await aClient.getMemory(USER);

  const b = recordingFetch([jsonResponse(record)]);
  const bClient = new ZaruClient({
    baseUrl: "http://zaru.test:3000",
    fetchImpl: b.fn,
  });
  await bClient.getMemory(USER);

  assert.equal(a.calls[0]!.url, "http://zaru.test:3000/api/zaru-memory");
  assert.equal(b.calls[0]!.url, "http://zaru.test:3000/api/zaru-memory");
  assert.equal(a.calls[0]!.url, b.calls[0]!.url);
});

// ---------------------------------------------------------------------------
// Auth token forwarding — uses the user's own token, not a static value
// ---------------------------------------------------------------------------

test("getMemory: forwards each user's own token (no shared/static token)", async () => {
  const record: ZaruMemoryRecord = {
    content: "x",
    version: 1,
    updated_at: "2026-04-25T00:00:00Z",
  };
  const { fn, calls } = recordingFetch([
    jsonResponse(record),
    jsonResponse(record),
  ]);
  const client = new ZaruClient({
    baseUrl: "http://zaru.test:3000",
    fetchImpl: fn,
  });

  await client.getMemory({ ...USER, token: "alice-token" });
  await client.getMemory({ ...USER, token: "bob-token" });

  assert.equal(calls[0]!.headers.Authorization, "Bearer alice-token");
  assert.equal(calls[1]!.headers.Authorization, "Bearer bob-token");
});

// ---------------------------------------------------------------------------
// VersionConflictError shape
// ---------------------------------------------------------------------------

test("VersionConflictError: name, instanceof Error, and default message use current.version", () => {
  const current: ZaruMemoryRecord = {
    content: "x",
    version: 42,
    updated_at: "2026-04-25T00:00:00Z",
  };
  const err = new VersionConflictError(current);
  assert.ok(err instanceof Error);
  assert.ok(err instanceof VersionConflictError);
  assert.equal(err.name, "VersionConflictError");
  assert.equal(err.current, current);
  assert.match(err.message, /version 42/);
});

test("VersionConflictError: explicit message overrides the default", () => {
  const current: ZaruMemoryRecord = {
    content: "x",
    version: 1,
    updated_at: "2026-04-25T00:00:00Z",
  };
  const err = new VersionConflictError(current, "custom msg");
  assert.equal(err.message, "custom msg");
});
