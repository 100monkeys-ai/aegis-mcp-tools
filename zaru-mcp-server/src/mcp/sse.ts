import type { Response } from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ZaruRequest, ZaruUser } from '../middleware/auth.js';
import { OrchestratorClient } from './orchestrator-client.js';

const orchestratorClient = new OrchestratorClient();

interface SseSession {
    transport: SSEServerTransport;
    user: ZaruUser;
}

/** Active SSE sessions keyed by transport sessionId */
const sessions = new Map<string, SseSession>();

/**
 * Creates an MCP Server instance wired to the orchestrator for a given user.
 */
function createMcpServerForUser(user: ZaruUser): Server {
    const server = new Server(
        {
            name: 'zaru-mcp-server',
            version: '0.14.0-pre-alpha',
        },
        {
            capabilities: {
                tools: {
                    listChanged: true,
                },
            },
            instructions: 'This MCP endpoint proxies AEGIS tools over SMCP v1.',
        }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const tools = await orchestratorClient.listTools(user);
        return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const result = await orchestratorClient.invokeTool(
            user,
            name,
            args ?? {},
            null
        );
        return normalizeToolResult(result);
    });

    return server;
}

function normalizeToolResult(result: unknown): { content: Array<{ type: string; text: string }>; isError: boolean } {
    if (
        result &&
        typeof result === 'object' &&
        ('content' in (result as Record<string, unknown>) ||
            'structuredContent' in (result as Record<string, unknown>))
    ) {
        return result as { content: Array<{ type: string; text: string }>; isError: boolean };
    }

    return {
        content: [
            {
                type: 'text',
                text:
                    typeof result === 'string'
                        ? result
                        : JSON.stringify(result, null, 2),
            },
        ],
        isError: false,
    };
}

/**
 * GET /mcp/v1/sse - Establish an SSE connection.
 *
 * The SDK's SSEServerTransport will:
 *  1. Send SSE headers
 *  2. Emit an `endpoint` event with the POST URL for sending messages
 *  3. Keep the connection open for server-to-client messages
 */
export async function handleSseConnection(req: ZaruRequest, res: Response): Promise<void> {
    const user = req.zaruUser;
    if (!user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }

    // The endpoint URL tells the client where to POST JSON-RPC messages.
    // The SSEServerTransport will append ?sessionId=<id> automatically.
    const transport = new SSEServerTransport('/mcp/v1/messages', res);

    const session: SseSession = { transport, user };
    sessions.set(transport.sessionId, session);

    console.log(`SSE session established: ${transport.sessionId} for user ${user.userId}`);

    // Clean up on disconnect
    res.on('close', () => {
        console.log(`SSE session closed: ${transport.sessionId}`);
        sessions.delete(transport.sessionId);
    });

    // Create an MCP Server instance for this user and connect it to the transport
    const mcpServer = createMcpServerForUser(user);
    await mcpServer.connect(transport);
}

/**
 * POST /mcp/v1/messages?sessionId=<id> - Receive JSON-RPC messages for an SSE session.
 *
 * The SSEServerTransport handles parsing and routing the message.
 * Auth is validated against the original SSE session's user.
 */
export async function handleSseMessage(req: ZaruRequest, res: Response): Promise<void> {
    const sessionId = req.query.sessionId as string | undefined;

    if (!sessionId) {
        res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32600, message: 'Missing sessionId query parameter' },
            id: null,
        });
        return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
        res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Session not found or expired' },
            id: null,
        });
        return;
    }

    await session.transport.handlePostMessage(req, res, req.body);
}
