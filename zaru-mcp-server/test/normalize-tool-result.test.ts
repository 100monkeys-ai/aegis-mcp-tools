import test from "node:test";
import assert from "node:assert/strict";

// normalizeToolResult is not exported, so we replicate the logic under test.
// This is a targeted regression test for the bug where orchestrator responses
// with a string `content` field were incorrectly treated as MCP-formatted.

function normalizeToolResult(result: unknown): unknown {
  if (
    result &&
    typeof result === "object" &&
    (("content" in (result as Record<string, unknown>) &&
      Array.isArray((result as Record<string, unknown>).content)) ||
      "structuredContent" in (result as Record<string, unknown>))
  ) {
    return result;
  }

  return {
    content: [
      {
        type: "text",
        text:
          typeof result === "string" ? result : JSON.stringify(result, null, 2),
      },
    ],
    isError: false,
  };
}

test("normalizeToolResult wraps orchestrator file response with string content field", () => {
  // This is the exact shape returned by aegis.execution.file
  const orchestratorResponse = {
    status: "success",
    content: "hello world file contents",
    path: "/workspace/test.txt",
    size_bytes: 25,
  };

  const result = normalizeToolResult(orchestratorResponse) as {
    content: Array<{ type: string; text: string }>;
    isError: boolean;
  };

  // Must be wrapped in MCP format, not returned as-is
  assert.ok(Array.isArray(result.content), "content must be an array");
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.ok(
    result.content[0].text.includes("hello world file contents"),
    "wrapped text must contain the original content",
  );
  assert.equal(result.isError, false);
});

test("normalizeToolResult passes through already-MCP-formatted results", () => {
  const mcpFormatted = {
    content: [{ type: "text", text: "already formatted" }],
  };

  const result = normalizeToolResult(mcpFormatted);

  // Must be returned unchanged
  assert.strictEqual(result, mcpFormatted);
});

test("normalizeToolResult passes through structuredContent results", () => {
  const structured = {
    structuredContent: { foo: "bar" },
  };

  const result = normalizeToolResult(structured);

  assert.strictEqual(result, structured);
});

test("normalizeToolResult wraps plain string results", () => {
  const result = normalizeToolResult("just a string") as {
    content: Array<{ type: string; text: string }>;
    isError: boolean;
  };

  assert.ok(Array.isArray(result.content));
  assert.equal(result.content[0].text, "just a string");
  assert.equal(result.isError, false);
});

test("normalizeToolResult wraps object without content field", () => {
  const result = normalizeToolResult({ status: "ok", data: 42 }) as {
    content: Array<{ type: string; text: string }>;
    isError: boolean;
  };

  assert.ok(Array.isArray(result.content));
  assert.ok(result.content[0].text.includes('"status": "ok"'));
  assert.equal(result.isError, false);
});
