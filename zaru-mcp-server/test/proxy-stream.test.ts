import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Minimal request / response mocks
// ---------------------------------------------------------------------------

function createMockReq() {
  const emitter = new EventEmitter();
  return {
    emitter,
    fireClose() {
      emitter.emit("close");
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      emitter.on(event, listener);
      return this;
    },
  };
}

function createMockRes() {
  const writes: string[] = [];
  let ended = false;
  return {
    writes,
    get writableEnded() {
      return ended;
    },
    write(chunk: string) {
      if (!ended) writes.push(chunk);
    },
    end() {
      ended = true;
    },
  };
}

// ---------------------------------------------------------------------------
// The pump logic extracted verbatim from index.ts so it can be unit-tested
// without spinning up Express.
// ---------------------------------------------------------------------------

async function runPump(
  reader: ReadableStreamDefaultReader<string>,
  req: ReturnType<typeof createMockReq>,
  res: ReturnType<typeof createMockRes>,
) {
  let clientDisconnected = false;

  req.on("close", () => {
    clientDisconnected = true;
    reader.cancel().catch(() => {});
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.writableEnded) res.write(value);
    }
  } catch {
    if (!clientDisconnected && !res.writableEnded) {
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: "stream terminated" })}\n\n`,
      );
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
}

// ---------------------------------------------------------------------------
// Test 1: orchestrator mid-stream error (client did NOT disconnect)
// ---------------------------------------------------------------------------

test("orchestrator mid-stream error writes SSE error frame and calls res.end()", async () => {
  const req = createMockReq();
  const res = createMockRes();

  // Reader yields one chunk then rejects
  let callCount = 0;
  const reader = {
    read(): Promise<{ done: boolean; value: string }> {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ done: false, value: "data: first\n\n" });
      }
      return Promise.reject(new Error("orchestrator socket closed"));
    },
    cancel(): Promise<void> {
      return Promise.resolve();
    },
  } as unknown as ReadableStreamDefaultReader<string>;

  await runPump(reader, req, res);

  // First chunk must have been forwarded
  assert.ok(
    res.writes.some((w) => w === "data: first\n\n"),
    "first chunk should be forwarded",
  );

  // Terminal SSE error frame must have been written
  const errorFrame = `event: error\ndata: ${JSON.stringify({ message: "stream terminated" })}\n\n`;
  assert.ok(
    res.writes.some((w) => w === errorFrame),
    `expected SSE error frame in writes, got: ${JSON.stringify(res.writes)}`,
  );

  // res.end() must have been called
  assert.equal(res.writableEnded, true, "res.end() should have been called");
});

// ---------------------------------------------------------------------------
// Test 2: client disconnects before pump error — no error frame, but res.end()
// ---------------------------------------------------------------------------

test("client disconnect suppresses SSE error frame but still calls res.end()", async () => {
  const req = createMockReq();
  const res = createMockRes();

  let callCount = 0;
  const reader = {
    read(): Promise<{ done: boolean; value: string }> {
      callCount++;
      if (callCount === 1) {
        // Fire the client close event synchronously before returning so that
        // clientDisconnected is set before the rejection is handled.
        req.fireClose();
        return Promise.reject(new Error("reader cancelled"));
      }
      return Promise.resolve({ done: true, value: "" });
    },
    cancel(): Promise<void> {
      return Promise.resolve();
    },
  } as unknown as ReadableStreamDefaultReader<string>;

  await runPump(reader, req, res);

  // No SSE error frame should have been written
  const errorFrame = `event: error\ndata: ${JSON.stringify({ message: "stream terminated" })}\n\n`;
  assert.ok(
    !res.writes.some((w) => w === errorFrame),
    "SSE error frame must NOT be written after client disconnect",
  );

  // res.end() must still have been called
  assert.equal(
    res.writableEnded,
    true,
    "res.end() should still be called after client disconnect",
  );
});
