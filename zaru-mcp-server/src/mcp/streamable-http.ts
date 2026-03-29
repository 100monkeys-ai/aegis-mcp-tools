import type { Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ZaruRequest, ZaruUser } from '../middleware/auth.js';
import { OrchestratorClient } from './orchestrator-client.js';

const orchestratorClient = new OrchestratorClient();

interface StreamableHttpSession {
    transport: StreamableHTTPServerTransport;
    server: McpServer;
    user: ZaruUser;
}

/** Active StreamableHTTP sessions keyed by Mcp-Session-Id header */
const sessions = new Map<string, StreamableHttpSession>();

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

function createMcpServerForUser(user: ZaruUser): McpServer {
    const mcpServer = new McpServer(
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

    mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => {
        const tools = await orchestratorClient.listTools(user);
        return { tools };
    });

    mcpServer.server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        try {
            const result = await orchestratorClient.invokeTool(
                user,
                name,
                args ?? {},
                null
            );
            return normalizeToolResult(result);
        } catch (error) {
            console.error(`Tool invocation failed: ${name}`, error instanceof Error ? error.message : error);
            throw error;
        }
    });

    return mcpServer;
}

/**
 * POST /mcp/v1 - Handle StreamableHTTP requests.
 *
 * Creates a per-request transport (stateless mode) or reuses an existing
 * session if an Mcp-Session-Id header is present.
 */
export async function handleStreamableHttp(req: ZaruRequest, res: Response): Promise<void> {
    const user = req.zaruUser;
    if (!user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // If a session ID is provided, try to reuse the existing session
    if (sessionId) {
        const existing = sessions.get(sessionId);
        if (existing) {
            await existing.transport.handleRequest(req, res, req.body);
            return;
        }
        // Session not found - fall through to create a new one
    }

    // Create a new transport and server for this session
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
    });

    const server = createMcpServerForUser(user);
    await server.connect(transport);


    // Store the session if a session ID was generated
    const newSessionId = transport.sessionId;
    if (newSessionId) {
        const session: StreamableHttpSession = { transport, server, user };
        sessions.set(newSessionId, session);

        console.log(`StreamableHTTP session established: ${newSessionId} for user ${user.userId}`);
    }

    await transport.handleRequest(req, res, req.body);
}

/**
 * GET /mcp/v1 - Server-initiated notifications via SSE (per StreamableHTTP spec).
 *
 * For now, we don't support server-initiated push, so return 405.
 */
export async function handleStreamableHttpGet(req: ZaruRequest, res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId) {
        const existing = sessions.get(sessionId);
        if (existing) {
            // Delegate to the transport's GET handling for SSE streams
            await existing.transport.handleRequest(req, res);
            return;
        }
    }

    res.status(405).json({ error: 'Method Not Allowed: server-initiated push not supported' });
}

/**
 * DELETE /mcp/v1 - Session cleanup.
 */
export async function handleStreamableHttpDelete(req: ZaruRequest, res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId) {
        res.status(400).json({ error: 'Missing Mcp-Session-Id header' });
        return;
    }

    const session = sessions.get(sessionId);
    if (session) {
        await session.server.close();
        sessions.delete(sessionId);
        console.log(`StreamableHTTP session deleted: ${sessionId}`);
    }

    res.status(200).json({ status: 'ok' });
}
