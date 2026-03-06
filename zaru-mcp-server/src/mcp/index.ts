import { ZaruRequest } from '../middleware/auth.js';
import { Response } from 'express';
import { generateKeyPairSync, sign } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

// Store active SMCP sessions mapped by LibreChat User ID
const smcpSessions = new Map<string, {
    token: string;
    privateKey: any; // KeyObject
    publicKey: any;
}>();

export async function handleMcpRequest(req: ZaruRequest, res: Response) {
    try {
        const user = req.zaruUser!;
        const body = req.body;

        if (!body || body.jsonrpc !== "2.0" || !body.method) {
            return res.status(400).json({ error: "Invalid JSON-RPC 2.0 request" });
        }

        const method = body.method;
        const id = body.id;

        console.log(`MCP [${method}] from user ${user.userId}`);

        let result: any = null;

        if (method === 'initialize') {
            result = {
                protocolVersion: "2024-11-05", // Standard MCP protocol version
                capabilities: {
                    tools: {
                        listChanged: false
                    }
                },
                serverInfo: {
                    name: "zaru-mcp-server",
                    version: "1.0.0"
                }
            };
        } else if (method === 'tools/list') {
            // Serve the capabilities of AEGIS
            result = {
                tools: [
                    {
                        name: "aegis.execute",
                        description: "Execute an agent or workflow on AEGIS Orchestrator.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                prompt: { type: "string" },
                                agent_id: { type: "string" }
                            },
                            required: ["prompt"]
                        }
                    },
                    {
                        name: "aegis.search_docs",
                        description: "Search 100monkeys and AEGIS documentation filenames and contents (simple grep).",
                        inputSchema: {
                            type: "object",
                            properties: {
                                query: { type: "string" }
                            },
                            required: ["query"]
                        }
                    },
                    {
                        name: "aegis.read_doc",
                        description: "Read a specific documentation page.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: { type: "string", description: "Path to the documentation file relative to the docs root. e.g. components/agent.mdx" }
                            },
                            required: ["path"]
                        }
                    },
                    {
                        name: "aegis.read_schema",
                        description: "Read ADRs, specifications, or schema files.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: { type: "string", description: "Path to the schema/ADR file relative to architecture repo root. e.g. AGENTS.md or adrs/001-bsl.md" }
                            },
                            required: ["path"]
                        }
                    }
                ]
            };
        } else if (method === 'tools/call') {
            const params = body.params || {};
            const toolName = params.name;
            const args = params.arguments || {};

            if (toolName === 'aegis.read_doc' || toolName === 'aegis.read_schema') {
                const baseDir = toolName === 'aegis.read_doc' ? '/app/docs' : '/app/architecture';
                const requestedPath = args.path || '';
                const resolvedPath = path.resolve(baseDir, requestedPath);

                if (!resolvedPath.startsWith(baseDir)) {
                    throw new Error("Path traversal detected.");
                }

                try {
                    const content = await fs.readFile(resolvedPath, 'utf-8');
                    result = {
                        content: [{ type: "text", text: content }],
                        isError: false
                    };
                } catch (err: any) {
                    result = {
                        content: [{ type: "text", text: `Error reading file: ${err.message}` }],
                        isError: true
                    };
                }
            } else if (toolName === 'aegis.search_docs') {
                const query = args.query || '';
                const baseDir = '/app/docs';
                // Very basic search simulation without child_process for security
                // Look for files in top directories
                try {
                    const searchResults: string[] = [];
                    const walkDir = async (dir: string) => {
                        const files = await fs.readdir(dir);
                        for (const file of files) {
                            const fullPath = path.join(dir, file);
                            const stat = await fs.stat(fullPath);
                            if (stat.isDirectory()) {
                                await walkDir(fullPath);
                            } else if (fullPath.endsWith('.md') || fullPath.endsWith('.mdx')) {
                                const content = await fs.readFile(fullPath, 'utf-8');
                                if (content.toLowerCase().includes(query.toLowerCase()) || file.toLowerCase().includes(query.toLowerCase())) {
                                    searchResults.push(fullPath.replace('/app/docs/', ''));
                                }
                            }
                        }
                    };
                    await walkDir(baseDir);
                    result = {
                        content: [{ type: "text", text: `Matching files:\n${searchResults.join('\n') || 'None found'}` }],
                        isError: false
                    };
                } catch (err: any) {
                    result = {
                        content: [{ type: "text", text: `Search error: ${err.message}` }],
                        isError: true
                    };
                }
            } else {
                // 1. Ensure SMCP Session
                let session = smcpSessions.get(user.userId);
                if (!session) {
                    session = await attestSession(user);
                    smcpSessions.set(user.userId, session);
                }

                // 2. Wrap MCP payload in SMCP envelope
                const mcpPayload = {
                    jsonrpc: "2.0",
                    method: toolName,
                    params: args,
                    id: id
                };

                const payloadStr = JSON.stringify(mcpPayload);
                const signature = sign(null, Buffer.from(payloadStr), session.privateKey).toString('base64');

                const envelope = {
                    security_token: session.token,
                    signature: signature,
                    payload: mcpPayload
                };

                // 3. Forward to AEGIS Orchestrator HTTP endpoint
                const aegisUrl = process.env.AEGIS_ORCHESTRATOR_URL || 'http://localhost:8088';
                const aegisRes = await fetch(`${aegisUrl}/v1/smcp/invoke`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(envelope)
                });

                if (!aegisRes.ok) {
                    throw new Error(`AEGIS Error: ${aegisRes.statusText} - ${await aegisRes.text()}`);
                }

                const aegisResultData = await aegisRes.json();

                // Format back to MCP tool call response
                result = {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(aegisResultData)
                        }
                    ],
                    isError: false
                };
            }
        } else {
            // Method not found handler
            return res.json({
                jsonrpc: "2.0",
                id: id,
                error: {
                    code: -32601,
                    message: `Method not found: ${method}`
                }
            });
        }

        // Return successful JSON-RPC response
        res.json({
            jsonrpc: "2.0",
            id: id,
            result: result
        });

    } catch (e: any) {
        console.error('MCP Request Error:', e);
        res.status(500).json({
            jsonrpc: "2.0",
            id: req.body?.id || null,
            error: {
                code: -32000,
                message: e.message || 'Internal Server Error'
            }
        });
    }
}

async function attestSession(user: { userId: string, tier: string }) {
    console.log(`Performing SMCP Attestation for user ${user.userId}`);

    // Generate ephemeral Ed25519 keypair for this session
    // Note: Node's crypto uses distinct types. We'll use Ed25519 for SMCP compliance
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');

    // Export public key in DER format, then bas64
    const pubKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

    const attRequest = {
        agent_id: `zaru-user-${user.userId}`, // Maps to AgentId::from_librechat_user in Rust
        container_id: `zaru-session-${Date.now()}`,
        public_key: pubKeyBase64,
        security_context: user.tier === 'default' ? 'zaru-free' : user.tier,
    };

    const aegisUrl = process.env.AEGIS_ORCHESTRATOR_URL || 'http://localhost:8088';
    const attestRes = await fetch(`${aegisUrl}/v1/smcp/attest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(attRequest)
    });

    if (!attestRes.ok) {
        throw new Error(`Attestation failed: ${attestRes.statusText} - ${await attestRes.text()}`);
    }

    const attestData = await attestRes.json() as any;

    return {
        token: attestData.security_token,
        privateKey,
        publicKey
    };
}
