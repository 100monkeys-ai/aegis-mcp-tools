import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { zaruAuthMiddleware, type ZaruRequest } from './middleware/auth.js';
import { handleSseConnection, handleSseMessage } from './mcp/sse.js';
import { handleStreamableHttp, handleStreamableHttpGet, handleStreamableHttpDelete } from './mcp/streamable-http.js';
import { OrchestratorClient } from './mcp/orchestrator-client.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const orchestratorClient = new OrchestratorClient();

app.use(cors());
app.use(express.json());

// SSE proxy for execution event streaming (Glass Laboratory)
app.get('/proxy/v1/executions/:executionId/stream', zaruAuthMiddleware, async (req: ZaruRequest, res) => {
    const { executionId } = req.params;
    const user = req.zaruUser;

    if (!user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }

    try {
        const response = await orchestratorClient.streamExecution(user, executionId as string);

        if (!response.ok) {
            res.status(response.status).json({ error: `Orchestrator returned ${response.status}` });
            return;
        }

        // Set SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        // Pipe the response body from orchestrator to client
        const reader = response.body?.getReader();
        if (!reader) {
            res.status(502).json({ error: 'No response body from orchestrator' });
            return;
        }

        const pump = async () => {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
            }
            res.end();
        };

        // Handle client disconnect
        req.on('close', () => {
            reader.cancel();
        });

        pump().catch(() => res.end());
    } catch (error) {
        if (!res.headersSent) {
            res.status(502).json({ error: 'Failed to connect to orchestrator' });
        }
    }
});

// StreamableHTTP transport (ADR-071 recommended)
app.post('/mcp/v1', zaruAuthMiddleware, handleStreamableHttp);
app.get('/mcp/v1', zaruAuthMiddleware, handleStreamableHttpGet);
app.delete('/mcp/v1', zaruAuthMiddleware, handleStreamableHttpDelete);

// Legacy SSE transport (backward compatibility)
app.get('/mcp/v1/sse', zaruAuthMiddleware, handleSseConnection);
app.post('/mcp/v1/messages', handleSseMessage);

app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});

app.listen(PORT, () => {
    console.log(`Zaru MCP Server running on port ${PORT}`);
});
