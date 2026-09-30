import express from "express";
import cors from "cors";
import { zaruAuthMiddleware, type ZaruRequest } from "./middleware/auth.js";
import {
  requestIdMiddleware,
  accessLogMiddleware,
} from "./middleware/request-logging.js";
import { handleSseConnection, handleSseMessage } from "./mcp/sse.js";
import {
  handleStreamableHttp,
  handleStreamableHttpGet,
  handleStreamableHttpDelete,
} from "./mcp/streamable-http.js";
import { OrchestratorClient } from "./mcp/orchestrator-client.js";
import {
  EXECUTION_STREAM_HEADERS,
  EXECUTION_STREAM_ROUTE,
  HEALTH_BODY,
  HEALTH_PATH,
  MCP_PATH,
  NO_UPSTREAM_BODY_ERROR,
  STREAM_TERMINATED_FRAME,
  executionStreamFailure,
  upstreamStatusFailure,
} from "./http/routes.js";

// The HTTP application, with every route and middleware, and no listener.
// `index.ts` starts it; tests drive it on an ephemeral loopback port.
export const app = express();
const orchestratorClient = new OrchestratorClient();

app.use(cors());
app.use(express.json());
app.use(requestIdMiddleware);
app.use(accessLogMiddleware);

// SSE proxy for execution event streaming (Glass Laboratory)
app.get(
  EXECUTION_STREAM_ROUTE,
  zaruAuthMiddleware,
  async (req: ZaruRequest, res) => {
    const { executionId } = req.params;
    const user = req.zaruUser;

    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    try {
      const response = await orchestratorClient.streamExecution(
        user,
        executionId as string,
      );

      if (!response.ok) {
        const failure = upstreamStatusFailure(response.status);
        res.status(failure.status).json({ error: failure.error });
        return;
      }

      // Set SSE headers
      for (const [name, value] of Object.entries(EXECUTION_STREAM_HEADERS)) {
        res.setHeader(name, value);
      }
      res.flushHeaders();

      // Pipe the response body from orchestrator to client
      const reader = response.body?.getReader();
      if (!reader) {
        res.status(502).json({ error: NO_UPSTREAM_BODY_ERROR });
        return;
      }

      let clientDisconnected = false;

      req.on("close", () => {
        clientDisconnected = true;
        reader.cancel().catch(() => {});
      });

      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.writableEnded) res.write(value);
          }
        } catch {
          if (!clientDisconnected && !res.writableEnded) {
            res.write(STREAM_TERMINATED_FRAME);
          }
        } finally {
          if (!res.writableEnded) res.end();
        }
      };

      pump();
    } catch (error) {
      // An invalid id throws before any header is sent, so this answers
      // 400 for it and 502 for a failed connection, as before.
      if (!res.headersSent) {
        const failure = executionStreamFailure(error);
        res.status(failure.status).json({ error: failure.error });
      }
    }
  },
);

// StreamableHTTP transport (ADR-071 recommended)
app.post(MCP_PATH, zaruAuthMiddleware, handleStreamableHttp);
app.get(MCP_PATH, zaruAuthMiddleware, handleStreamableHttpGet);
app.delete(MCP_PATH, zaruAuthMiddleware, handleStreamableHttpDelete);

// Legacy SSE transport (backward compatibility)
app.get("/mcp/v1/sse", zaruAuthMiddleware, handleSseConnection);
app.post("/mcp/v1/messages", handleSseMessage);

app.get(HEALTH_PATH, (_req, res) => {
  res.json(HEALTH_BODY);
});
