import test from 'node:test';
import assert from 'node:assert/strict';
import { OrchestratorClient } from '../src/mcp/orchestrator-client.js';

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            'Content-Type': 'application/json'
        }
    });
}

test('listTools uses orchestrator discovery and caches by security context', async () => {
    const calls: Array<{ method: string; url: string; headers?: Record<string, string> }> = [];
    const client = new OrchestratorClient({
        baseUrl: 'http://aegis.test',
        toolDiscoveryUrl: 'http://aegis.test/v1/smcp/tools',
        cacheTtlMs: 60_000,
        fetchImpl: async (input, init) => {
            calls.push({
                method: init?.method ?? 'GET',
                url: String(input),
                headers: init?.headers as Record<string, string> | undefined
            });
            return jsonResponse({
                tools: [
                    {
                        name: 'fs.read',
                        description: 'Read a file',
                        inputSchema: { type: 'object' }
                    },
                    {
                        name: 'aegis.task.logs',
                        description: 'Fetch task execution logs',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                execution_id: { type: 'string' },
                                limit: { type: 'integer' },
                                offset: { type: 'integer' }
                            },
                            required: ['execution_id']
                        }
                    }
                ]
            });
        }
    });

    const user = {
        userId: 'user-1',
        tier: 'free',
        securityContext: 'zaru-free',
        token: 'jwt'
    };

    const first = await client.listTools(user);
    const second = await client.listTools(user);

    assert.equal(first[0]?.name, 'fs.read');
    assert.equal(first[1]?.name, 'aegis.task.logs');
    assert.equal(second[0]?.name, 'fs.read');
    assert.equal(second[1]?.name, 'aegis.task.logs');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
        method: 'GET',
        url: 'http://aegis.test/v1/smcp/tools',
        headers: {
            Accept: 'application/json',
            'X-Zaru-Security-Context': 'zaru-free'
        }
    });
});

test('invokeTool attests and sends a spec-shaped SMCP envelope', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const client = new OrchestratorClient({
        baseUrl: 'http://aegis.test',
        fetchImpl: async (input, init) => {
            const url = String(input);
            const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
            calls.push({ url, body });

            if (url.endsWith('/v1/smcp/attest')) {
                return jsonResponse({ security_token: 'issued-token' });
            }

            if (url.endsWith('/v1/smcp/invoke')) {
                return jsonResponse({
                    jsonrpc: '2.0',
                    id: 'req-2',
                    result: {
                        content: [{ type: 'text', text: 'ok' }],
                        isError: false
                    }
                });
            }

            return jsonResponse({}, 404);
        }
    });

    const user = {
        userId: 'user-2',
        tier: 'enterprise',
        securityContext: 'zaru-enterprise',
        token: 'jwt'
    };

    const result = await client.invokeTool(
        user,
        'aegis.task.logs',
        { execution_id: 'exec-123', limit: 50, offset: 0 },
        'req-2'
    );

    assert.deepEqual(result, {
        content: [{ type: 'text', text: 'ok' }],
        isError: false
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, 'http://aegis.test/v1/smcp/attest');
    assert.equal(calls[0]?.body?.user_id, 'user-2');
    assert.equal(calls[0]?.body?.workload_id?.toString().startsWith('zaru:user-2:'), true);
    assert.equal(calls[0]?.body?.security_context, 'zaru-enterprise');
    assert.equal(calls[0]?.body?.zaru_tier, 'enterprise');
    assert.equal(calls[0]?.body?.agent_id, undefined);
    assert.equal(calls[0]?.body?.execution_id, undefined);
    assert.equal(typeof calls[0]?.body?.agent_public_key, 'string');
    assert.equal(calls[1]?.url, 'http://aegis.test/v1/smcp/invoke');
    assert.equal(calls[1]?.body?.protocol, 'smcp/v1');
    assert.equal(calls[1]?.body?.security_token, 'issued-token');
    assert.equal((calls[1]?.body?.payload as { method: string }).method, 'tools/call');
    assert.deepEqual((calls[1]?.body?.payload as { params: unknown }).params, {
        name: 'aegis.task.logs',
        arguments: {
            execution_id: 'exec-123',
            limit: 50,
            offset: 0
        }
    });
    assert.equal(typeof calls[1]?.body?.timestamp, 'string');
    assert.equal(typeof calls[1]?.body?.signature, 'string');
});
