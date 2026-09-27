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
  "/proxy/v1/executions/:executionId/stream",
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
        res
          .status(response.status)
          .json({ error: `Orchestrator returned ${response.status}` });
        return;
      }

      // Set SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      // Pipe the response body from orchestrator to client
      const reader = response.body?.getReader();
      if (!reader) {
        res.status(502).json({ error: "No response body from orchestrator" });
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
            res.write(
              `event: error\ndata: ${JSON.stringify({ message: "stream terminated" })}\n\n`,
            );
          }
        } finally {
          if (!res.writableEnded) res.end();
        }
      };

      pump();
    } catch (error) {
      if (!res.headersSent) {
        res.status(502).json({ error: "Failed to connect to orchestrator" });
      }
    }
  },
);

// StreamableHTTP transport (ADR-071 recommended)
app.post("/mcp/v1", zaruAuthMiddleware, handleStreamableHttp);
app.get("/mcp/v1", zaruAuthMiddleware, handleStreamableHttpGet);
app.delete("/mcp/v1", zaruAuthMiddleware, handleStreamableHttpDelete);

// Legacy SSE transport (backward compatibility)
app.get("/mcp/v1/sse", zaruAuthMiddleware, handleSseConnection);
app.post("/mcp/v1/messages", handleSseMessage);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});
