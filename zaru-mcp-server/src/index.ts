import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { zaruAuthMiddleware } from './middleware/auth.js';
import { handleSseConnection, handleSseMessage } from './mcp/sse.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// SSE transport endpoints (MCP protocol version 2024-11-05)
app.get('/mcp/v1/sse', zaruAuthMiddleware, handleSseConnection);
app.post('/mcp/v1/messages', handleSseMessage);

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.listen(PORT, () => {
    console.log(`Zaru MCP Server running on port ${PORT}`);
});
