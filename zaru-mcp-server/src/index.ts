import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { zaruAuthMiddleware } from './middleware/auth.js';
import { handleMcpRequest } from './mcp/index.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Main MCP endpoint called by LibreChat
app.post('/mcp/v1/', zaruAuthMiddleware, handleMcpRequest);

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.listen(PORT, () => {
    console.log(`Zaru MCP Server running on port ${PORT}`);
});
