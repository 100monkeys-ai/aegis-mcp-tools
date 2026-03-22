import type { Response } from 'express';
import { ZaruRequest } from '../middleware/auth.js';
import { OrchestratorClient } from './orchestrator-client.js';

const orchestratorClient = new OrchestratorClient();

function invalidRequest(res: Response, id: string | number | null, message: string) {
    return res.status(400).json({
        jsonrpc: '2.0',
        id,
        error: {
            code: -32600,
            message
        }
    });
}

function success(res: Response, id: string | number | null, result: unknown) {
    return res.json({
        jsonrpc: '2.0',
        id,
        result
    });
}

function methodNotFound(res: Response, id: string | number | null, method: string) {
    return res.status(404).json({
        jsonrpc: '2.0',
        id,
        error: {
            code: -32601,
            message: `Method not found: ${method}`
        }
    });
}

function normalizeToolResult(result: unknown): unknown {
    if (
        result &&
        typeof result === 'object' &&
        ('content' in (result as Record<string, unknown>) || 'structuredContent' in (result as Record<string, unknown>))
    ) {
        return result;
    }

    return {
        content: [
            {
                type: 'text',
                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
            }
        ],
        isError: false
    };
}

export async function handleMcpRequest(req: ZaruRequest, res: Response) {
    try {
        const user = req.zaruUser;
        const body = req.body as Record<string, unknown> | undefined;

        if (!user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
            return invalidRequest(res, null, 'Invalid JSON-RPC 2.0 request');
        }

        const id = typeof body.id === 'string' || typeof body.id === 'number' ? body.id : null;
        const method = body.method;

        if (method === 'initialize') {
            return success(res, id, {
                protocolVersion: '2024-11-05',
                capabilities: {
                    tools: {
                        listChanged: true
                    }
                },
                serverInfo: {
                    name: 'zaru-mcp-server',
                    version: '0.14.0-pre-alpha'
                },
                instructions: 'This MCP endpoint proxies AEGIS tools over SMCP v1.',
                _meta: {
                    smcp: {
                        protocol: 'smcp/v1',
                        transport: 'streamable-http',
                        discovery: 'orchestrator'
                    }
                }
            });
        }

        if (method === 'tools/list') {
            const tools = await orchestratorClient.listTools(user);
            return success(res, id, { tools });
        }

        if (method === 'tools/call') {
            const params = (body.params as Record<string, unknown> | undefined) ?? {};
            const toolName = params.name;
            const toolArgs = (params.arguments as Record<string, unknown> | undefined) ?? {};

            if (typeof toolName !== 'string' || toolName.length === 0) {
                return invalidRequest(res, id, 'tools/call requires params.name');
            }

            const result = await orchestratorClient.invokeTool(user, toolName, toolArgs, id);
            return success(res, id, normalizeToolResult(result));
        }

        return methodNotFound(res, id, method);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Internal Server Error';
        return res.status(500).json({
            jsonrpc: '2.0',
            id: (req.body?.id as string | number | null | undefined) ?? null,
            error: {
                code: -32000,
                message
            }
        });
    }
}
