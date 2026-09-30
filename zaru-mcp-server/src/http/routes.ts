import { InvalidExecutionIdError } from "../mcp/orchestrator-client.js";

// What the Express app (`src/app.ts`) and the Workers fetch handler
// (`src/worker.ts`) share about their routes, so the two entrypoints answer
// alike: the paths, the health body, and the execution SSE proxy's headers,
// error frame and failure mapping. The tool wiring they share is
// `createMcpServerForUser` in `src/mcp/streamable-http.ts`, and the
// authentication `authenticateZaruRequest` in `src/middleware/auth.ts`.

export const HEALTH_PATH = "/health";
export const MCP_PATH = "/mcp/v1";
export const EXECUTION_STREAM_ROUTE = "/proxy/v1/executions/:executionId/stream";

/** Matches EXECUTION_STREAM_ROUTE and captures the raw `executionId` segment. */
export const EXECUTION_STREAM_PATTERN =
  /^\/proxy\/v1\/executions\/([^/]+)\/stream$/;

export const HEALTH_BODY = { status: "ok" } as const;

/** Response headers of the execution SSE proxy. */
export const EXECUTION_STREAM_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/** The frame written when the orchestrator's stream fails mid-way. */
export const STREAM_TERMINATED_FRAME = `event: error\ndata: ${JSON.stringify({ message: "stream terminated" })}\n\n`;

/** The refusal sent when the orchestrator answers the stream request with an error status. */
export function upstreamStatusFailure(status: number): {
  status: number;
  error: string;
} {
  return { status, error: `Orchestrator returned ${status}` };
}

/** The refusal sent when opening the orchestrator's stream throws. */
export function executionStreamFailure(error: unknown): {
  status: number;
  error: string;
} {
  if (error instanceof InvalidExecutionIdError) {
    return { status: 400, error: error.message };
  }
  return { status: 502, error: "Failed to connect to orchestrator" };
}

export const NO_UPSTREAM_BODY_ERROR = "No response body from orchestrator";
