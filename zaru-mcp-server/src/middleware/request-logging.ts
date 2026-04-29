import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "crypto";
import { log } from "../logging.js";
import type { ZaruRequest } from "./auth.js";

/**
 * Express middleware that:
 *   1. Ensures every request has a `request_id` (echoes incoming
 *      `x-request-id` header or mints a UUID when absent).
 *   2. Sets `X-Request-Id` on the response so callers can correlate.
 *   3. Emits one structured `http.request` log on response `finish`
 *      with method/path/status/duration_ms/remote_ip/user_agent_short
 *      and the resolved authenticated subject (sub claim, tenant id).
 *
 * 4xx → warn, 5xx → error, otherwise info. The duration is computed
 * from `process.hrtime.bigint()` taken at request start so the value
 * is monotonic and unaffected by wall-clock skew.
 */
export interface RequestWithId extends Request {
  requestId?: string;
}

export function requestIdMiddleware(
  req: RequestWithId,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.headers["x-request-id"];
  const headerValue =
    typeof incoming === "string" && incoming.length > 0
      ? incoming
      : Array.isArray(incoming) && incoming[0]
        ? incoming[0]
        : undefined;
  const id = headerValue ?? randomUUID();
  req.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}

function shortUserAgent(
  value: string | string[] | undefined,
): string | undefined {
  if (!value) return undefined;
  const raw = Array.isArray(value) ? value.join(" ") : value;
  return raw.length > 80 ? raw.slice(0, 80) : raw;
}

function resolveSubject(req: ZaruRequest): {
  authenticated_subject?: string;
  tenant_id?: string;
} {
  const u = req.zaruUser;
  if (!u) return {};
  return {
    authenticated_subject: u.userId,
    tenant_id: u.tenantId,
  };
}

export function accessLogMiddleware(
  req: RequestWithId & ZaruRequest,
  res: Response,
  next: NextFunction,
): void {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationNs = process.hrtime.bigint() - start;
    const duration_ms = Number(durationNs / 1_000_000n);
    const status = res.statusCode;
    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    const subject = resolveSubject(req);
    log(level, "http.request", {
      request_id: req.requestId,
      method: req.method,
      path: req.originalUrl ?? req.url,
      status,
      duration_ms,
      remote_ip: req.ip,
      user_agent_short: shortUserAgent(req.headers["user-agent"]),
      ...subject,
    });
  });
  next();
}
