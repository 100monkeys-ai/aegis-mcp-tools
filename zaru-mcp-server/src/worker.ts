// The Cloudflare Workers entrypoint (AEGIS ADR-123, plan step S5): the routes
// of the Express app in `src/app.ts`, served by a fetch handler from the same
// modules. The Express app keeps running in the container until the pod is
// removed (plan step S7).
//
// Served here: GET /health; the stateless Streamable HTTP MCP transport on
// /mcp/v1, through the SDK's Web-standard transport; and the execution SSE
// proxy, streamed as the Response body. Not served: the legacy SSE transport
// (`/mcp/v1/sse`, `/mcp/v1/messages`), whose sessions live in one process's
// memory (ADR-123's delegated ruling on U4: dropped in the Worker port).
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env } from "./env.js";
import {
  EXECUTION_STREAM_HEADERS,
  EXECUTION_STREAM_PATTERN,
  HEALTH_BODY,
  HEALTH_PATH,
  MCP_PATH,
  NO_UPSTREAM_BODY_ERROR,
  STREAM_TERMINATED_FRAME,
  executionStreamFailure,
  upstreamStatusFailure,
} from "./http/routes.js";
import { log } from "./logging.js";
import {
  authenticateZaruRequest,
  type ZaruRequestHeaders,
  type ZaruUser,
} from "./middleware/auth.js";
import {
  OrchestratorClient,
  WAIT_CEILING_SECONDS,
} from "./mcp/orchestrator-client.js";
import {
  ZARU_CONTEXTS_HEADER,
  ZARU_CONVERSATION_HEADER,
  ZARU_TURN_HEADER,
  carriesZaruTurn,
  createMcpServerForUser,
  parseCapabilitiesHeader,
  parseContextsHeader,
  parseConversationHeader,
} from "./mcp/streamable-http.js";

// Per isolate, as the container's is per process: its caches are the SEAL
// sessions and a tool list with a 5 s time to live. The wait ceiling is set
// here and nowhere else: an MCP client gives up on a tool call after about a
// minute, so a tool whose name ends in ".wait" waits at most
// WAIT_CEILING_SECONDS per call on the Worker (AEGIS known-defects-4).
const orchestratorClient = new OrchestratorClient({
  waitCeilingSeconds: WAIT_CEILING_SECONDS,
});

const CORS_ALLOW_METHODS = "GET,HEAD,PUT,PATCH,POST,DELETE";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** Header names lowercased, as Node presents them to the Express app. */
function headerRecord(headers: Headers): ZaruRequestHeaders {
  const out: ZaruRequestHeaders = {};
  headers.forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

async function authenticate(
  request: Request,
  url: URL,
): Promise<{ user: ZaruUser } | { refusal: Response }> {
  const result = await authenticateZaruRequest(
    headerRecord(request.headers),
    Object.fromEntries(url.searchParams),
  );
  if ("user" in result) return { user: result.user };
  return { refusal: json({ error: result.error }, result.status) };
}

async function handleMcpPost(
  request: Request,
  user: ZaruUser,
  requestId: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const capabilities = parseCapabilitiesHeader(
    request.headers.get("x-zaru-capabilities") ?? undefined,
  );
  const chosen = parseContextsHeader(request.headers.get(ZARU_CONTEXTS_HEADER));
  if ("error" in chosen) return json({ error: chosen.error }, 400);
  const conversation = parseConversationHeader(
    request.headers.get(ZARU_CONVERSATION_HEADER),
  );
  if ("error" in conversation) return json({ error: conversation.error }, 400);
  // Stateless, as src/mcp/streamable-http.ts: a fresh transport and server
  // per request, holding nothing between requests.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createMcpServerForUser(
    user,
    capabilities,
    requestId,
    orchestratorClient,
    {
      zaruTurn: carriesZaruTurn(request.headers.get(ZARU_TURN_HEADER)),
      contexts: chosen.contexts,
      profile: chosen.profile,
      conversationId: conversation.conversationId,
    },
  );
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    ctx.waitUntil(Promise.all([transport.close(), server.close()]));
  }
}

async function handleExecutionStream(
  user: ZaruUser,
  executionId: string,
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await orchestratorClient.streamExecution(user, executionId);
  } catch (error) {
    const failure = executionStreamFailure(error);
    return json({ error: failure.error }, failure.status);
  }
  if (!upstream.ok) {
    const failure = upstreamStatusFailure(upstream.status);
    return json({ error: failure.error }, failure.status);
  }
  if (!upstream.body) {
    return json({ error: NO_UPSTREAM_BODY_ERROR }, 502);
  }

  // Pass each chunk through as it arrives. A failure of the upstream stream
  // ends the body with the same error frame the Express route writes; the
  // client going away cancels the upstream read.
  const reader = upstream.body.getReader();
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch {
        controller.enqueue(encoder.encode(STREAM_TERMINATED_FRAME));
        controller.close();
      }
    },
    cancel() {
      return reader.cancel().catch(() => {});
    },
  });
  return new Response(body, { status: 200, headers: EXECUTION_STREAM_HEADERS });
}

async function route(
  request: Request,
  url: URL,
  requestId: string,
  ctx: ExecutionContext,
  subject: { user?: ZaruUser },
): Promise<Response> {
  const { pathname } = url;
  const method = request.method;

  if (pathname === HEALTH_PATH && (method === "GET" || method === "HEAD")) {
    return json(HEALTH_BODY);
  }

  const streamMatch = EXECUTION_STREAM_PATTERN.exec(pathname);
  const isMcp =
    pathname === MCP_PATH &&
    (method === "POST" || method === "GET" || method === "DELETE");
  const isStream = streamMatch !== null && method === "GET";
  if (!isMcp && !isStream) {
    return json({ error: "Not Found" }, 404);
  }

  const auth = await authenticate(request, url);
  if ("refusal" in auth) return auth.refusal;
  subject.user = auth.user;

  if (isStream) {
    let executionId: string;
    try {
      executionId = decodeURIComponent(streamMatch[1]);
    } catch {
      // Not decodable: pass it on raw, and the id check refuses it (400).
      executionId = streamMatch[1];
    }
    return handleExecutionStream(auth.user, executionId);
  }
  if (method === "POST") {
    return handleMcpPost(request, auth.user, requestId, ctx);
  }
  if (method === "GET") {
    // Stateless mode has no server-initiated push, as the Express route says.
    return json(
      { error: "Method Not Allowed: server-initiated push not supported" },
      405,
    );
  }
  // DELETE: stateless mode holds no session, so it is a no-op.
  return json({ status: "ok" });
}

function withCommonHeaders(
  response: Response,
  request: Request,
  requestId: string,
): Response {
  // Rebuilt so the headers are mutable whatever produced the response.
  const out = new Response(response.body, response);
  out.headers.set("Access-Control-Allow-Origin", "*");
  out.headers.set("X-Request-Id", requestId);
  if (request.method === "OPTIONS") {
    out.headers.set("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
    const requested = request.headers.get("access-control-request-headers");
    if (requested) {
      out.headers.set("Access-Control-Allow-Headers", requested);
      out.headers.append("Vary", "Access-Control-Request-Headers");
    }
  }
  return out;
}

function shortUserAgent(value: string | null): string | undefined {
  if (!value) return undefined;
  return value.length > 80 ? value.slice(0, 80) : value;
}

export default {
  async fetch(
    request: Request,
    _env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const started = Date.now();
    const url = new URL(request.url);
    const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
    const subject: { user?: ZaruUser } = {};

    let response: Response;
    if (request.method === "OPTIONS") {
      // CORS preflight, answered as the Express app's `cors()` does.
      response = new Response(null, { status: 204 });
    } else {
      try {
        response = await route(request, url, requestId, ctx, subject);
      } catch (error) {
        log("error", "http.unhandled", {
          request_id: requestId,
          error: error instanceof Error ? error : { message: String(error) },
        });
        response = json({ error: "Internal Server Error" }, 500);
      }
    }

    const status = response.status;
    log(
      status >= 500 ? "error" : status >= 400 ? "warn" : "info",
      "http.request",
      {
        request_id: requestId,
        method: request.method,
        // The path without its query: a `token` query parameter is a credential.
        path: url.pathname,
        status,
        duration_ms: Date.now() - started,
        remote_ip: request.headers.get("cf-connecting-ip") ?? undefined,
        user_agent_short: shortUserAgent(request.headers.get("user-agent")),
        authenticated_subject: subject.user?.userId,
        tenant_id: subject.user?.tenantId,
      },
    );
    return withCommonHeaders(response, request, requestId);
  },
} satisfies ExportedHandler<Env>;
