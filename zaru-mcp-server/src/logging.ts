/// <reference types="node" />
// Dependency-free structured JSON logger for the zaru-mcp-server.
//
// Writes one JSON object per line to stdout via `process.stdout.write` —
// promtail scrapes container stdout into Loki. Uses `process.stdout.write`
// rather than `console.log` to bypass Node's potential reordering and
// buffering quirks under load (console.log goes through util.formatWithOptions
// and may interleave with stderr in pipelines). One newline-terminated JSON
// document per call gives Loki/JSON parsers a clean record boundary.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveThreshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  if (raw in LEVEL_RANK) return LEVEL_RANK[raw as LogLevel];
  return LEVEL_RANK.info;
}

// Resolved on every call so tests can mutate `process.env.LOG_LEVEL`
// at runtime; cost is negligible (one map lookup per log call).

const SENSITIVE_KEY_PATTERN =
  /^(authorization|cookie|set-cookie|x-tenant-id|bearer|secret|token|password|webhook_secret|signed_envelope)$/i;

const JWT_SHAPE = /^(eyJ[A-Za-z0-9_-]+\.){2}[A-Za-z0-9_-]+$/;

const REDACTED = "<redacted>";

/**
 * Recursively scrub values that look like credentials. Returns a new
 * structure — the input is never mutated. Applied automatically inside
 * `log()` so callers cannot accidentally leak.
 */
export function redact(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    return JWT_SHAPE.test(value) ? REDACTED : value;
  }
  if (typeof value !== "object") return value;
  if (seen.has(value as object)) return "<cycle>";
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = redact(v, seen);
    }
  }
  return out;
}

function serializeError(err: Error): Record<string, unknown> {
  const stack = typeof err.stack === "string" ? err.stack.split("\n") : [];
  // Drop the "<Name>: <message>" header line if present, keep the last 5 frames.
  const frames =
    stack.length > 0 && stack[0].startsWith(err.name) ? stack.slice(1) : stack;
  return {
    message: err.message,
    name: err.name,
    stack_tail: frames.slice(-5).map((s) => s.trim()),
  };
}

function preprocess(value: unknown, seen: WeakSet<object>): unknown {
  if (value instanceof Error) return serializeError(value);
  if (value == null) return value;
  if (typeof value !== "object") return value;
  if (seen.has(value as object)) return "<cycle>";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => preprocess(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = preprocess(v, seen);
  }
  return out;
}

export function log(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (LEVEL_RANK[level] < resolveThreshold()) return;

  const processed = preprocess(fields, new WeakSet()) as Record<
    string,
    unknown
  >;
  const redacted = redact(processed) as Record<string, unknown>;

  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...redacted,
  };

  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      event: "log.serialize_failed",
      original_event: event,
    });
  }
  process.stdout.write(line + "\n");
}

export const logDebug = (event: string, fields?: Record<string, unknown>) =>
  log("debug", event, fields);
export const logInfo = (event: string, fields?: Record<string, unknown>) =>
  log("info", event, fields);
export const logWarn = (event: string, fields?: Record<string, unknown>) =>
  log("warn", event, fields);
export const logError = (event: string, fields?: Record<string, unknown>) =>
  log("error", event, fields);
