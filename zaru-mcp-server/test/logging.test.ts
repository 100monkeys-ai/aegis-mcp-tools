import test from "node:test";
import assert from "node:assert/strict";

import { log, redact, logInfo } from "../src/logging.js";
import {
  requestIdMiddleware,
  type RequestWithId,
} from "../src/middleware/request-logging.js";

// Capture every line written to stdout while `fn` runs and return the
// parsed JSON records. The logger writes one `{...}\n` document per
// call; we split on newline to recover individual records.
function captureStdout(fn: () => void): unknown[] {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  (process.stdout.write as unknown) = (chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks
    .join("")
    .split("\n")
    .filter((s) => s.length > 0)
    .map((s) => JSON.parse(s));
}

test("log() writes a single newline-terminated JSON record with required fields", () => {
  const records = captureStdout(() => {
    logInfo("test.event", { foo: "bar" });
  });
  assert.equal(records.length, 1);
  const r = records[0] as Record<string, unknown>;
  assert.ok(typeof r.ts === "string" && r.ts.endsWith("Z"));
  assert.equal(r.level, "info");
  assert.equal(r.event, "test.event");
  assert.equal(r.foo, "bar");
});

test("LOG_LEVEL=warn suppresses info and debug entries", () => {
  const prev = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "warn";
  try {
    const records = captureStdout(() => {
      log("debug", "drop.debug", {});
      log("info", "drop.info", {});
      log("warn", "keep.warn", {});
      log("error", "keep.error", {});
    });
    const events = records.map((r) => (r as { event: string }).event);
    assert.deepEqual(events, ["keep.warn", "keep.error"]);
  } finally {
    process.env.LOG_LEVEL = prev;
  }
});

test("redact() scrubs sensitive keys, JWT-shaped strings, and nested values", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signaturepartXYZ_-abc";
  const input = {
    authorization: "Bearer abc",
    cookie: "session=xyz",
    password: "hunter2",
    secret: "shh",
    webhook_secret: "topsecret",
    token: jwt,
    nested: {
      bearer: "another",
      keep_me: "ok",
      raw_jwt: jwt,
    },
    safe: "value",
  };
  const out = redact(input) as Record<string, unknown>;
  assert.equal(out.authorization, "<redacted>");
  assert.equal(out.cookie, "<redacted>");
  assert.equal(out.password, "<redacted>");
  assert.equal(out.secret, "<redacted>");
  assert.equal(out.webhook_secret, "<redacted>");
  assert.equal(out.token, "<redacted>");
  const nested = out.nested as Record<string, unknown>;
  assert.equal(nested.bearer, "<redacted>");
  assert.equal(nested.keep_me, "ok");
  assert.equal(nested.raw_jwt, "<redacted>");
  assert.equal(out.safe, "value");
});

test("redact() also runs automatically inside log() so callers can't leak", () => {
  const records = captureStdout(() => {
    logInfo("call", {
      authorization: "Bearer abc",
      headers: { cookie: "session=xyz" },
    });
  });
  const r = records[0] as Record<string, unknown>;
  assert.equal(r.authorization, "<redacted>");
  assert.equal((r.headers as Record<string, unknown>).cookie, "<redacted>");
});

test("Error fields serialize to {message, name, stack_tail} with short stack_tail", () => {
  const records = captureStdout(() => {
    const err = new Error("boom");
    logInfo("e", { error: err });
  });
  const e = (records[0] as Record<string, unknown>).error as Record<
    string,
    unknown
  >;
  assert.equal(e.message, "boom");
  assert.equal(e.name, "Error");
  assert.ok(Array.isArray(e.stack_tail));
  assert.ok((e.stack_tail as unknown[]).length <= 5);
});

test("requestIdMiddleware mints a UUID when x-request-id is absent", () => {
  const req = { headers: {} } as RequestWithId;
  let respHeader: string | undefined;
  const res = {
    setHeader: (k: string, v: string) => {
      if (k === "X-Request-Id") respHeader = v;
    },
  } as unknown as Parameters<typeof requestIdMiddleware>[1];
  let nextCalled = false;
  requestIdMiddleware(req, res, () => {
    nextCalled = true;
  });
  assert.ok(nextCalled);
  assert.ok(req.requestId && req.requestId.length >= 32);
  assert.equal(respHeader, req.requestId);
});

test("requestIdMiddleware preserves an incoming x-request-id header", () => {
  const req = {
    headers: { "x-request-id": "incoming-id-1" },
  } as unknown as RequestWithId;
  let respHeader: string | undefined;
  const res = {
    setHeader: (k: string, v: string) => {
      if (k === "X-Request-Id") respHeader = v;
    },
  } as unknown as Parameters<typeof requestIdMiddleware>[1];
  requestIdMiddleware(req, res, () => {});
  assert.equal(req.requestId, "incoming-id-1");
  assert.equal(respHeader, "incoming-id-1");
});
