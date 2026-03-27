import type { ZaruUser } from '../middleware/auth.js';
import { buildSmcpEnvelope, createSessionId, createSessionKeyPair, type ZaruSmcpSession } from './smcp.js';
import type { AegisToolDefinition, JsonRpcRequest } from './types.js';

type FetchLike = typeof fetch;

interface AttestationResponse {
    security_token: string;
    expires_at?: string;
}

interface ToolDiscoveryCacheEntry {
    tools: AegisToolDefinition[];
    expiresAt: number;
}

export interface OrchestratorClientOptions {
    baseUrl?: string;
    toolDiscoveryUrl?: string;
    fetchImpl?: FetchLike;
    cacheTtlMs?: number;
}

function normalizeBaseUrl(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

function resolveUrl(baseUrl: string, path: string): string {
    return `${normalizeBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
}

function normalizeToolList(payload: unknown): AegisToolDefinition[] {
    if (Array.isArray(payload)) {
        return payload as AegisToolDefinition[];
    }

    if (!payload || typeof payload !== 'object') {
        throw new Error('Tool discovery response was not an object');
    }

    const objectPayload = payload as Record<string, unknown>;
    if (Array.isArray(objectPayload.tools)) {
        return objectPayload.tools as AegisToolDefinition[];
    }

    if (
        objectPayload.result &&
        typeof objectPayload.result === 'object' &&
        Array.isArray((objectPayload.result as Record<string, unknown>).tools)
    ) {
        return (objectPayload.result as Record<string, unknown>).tools as AegisToolDefinition[];
    }

    throw new Error('Tool discovery response did not contain a tools array');
}

function normalizeToolCallResult(payload: unknown): unknown {
    if (
        payload &&
        typeof payload === 'object' &&
        'result' in (payload as Record<string, unknown>) &&
        'jsonrpc' in (payload as Record<string, unknown>)
    ) {
        return (payload as Record<string, unknown>).result;
    }

    return payload;
}

export class OrchestratorClient {
    private readonly baseUrl: string;
    private readonly toolDiscoveryUrl: string;
    private readonly fetchImpl: FetchLike;
    private readonly cacheTtlMs: number;
    private readonly sessionCache = new Map<string, ZaruSmcpSession>();
    private readonly toolCache = new Map<string, ToolDiscoveryCacheEntry>();

    constructor(options: OrchestratorClientOptions = {}) {
        this.baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.AEGIS_ORCHESTRATOR_URL ?? 'http://localhost:8088');
        this.toolDiscoveryUrl =
            options.toolDiscoveryUrl ??
            process.env.AEGIS_TOOL_DISCOVERY_URL ??
            resolveUrl(this.baseUrl, '/v1/smcp/tools');
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.cacheTtlMs = options.cacheTtlMs ?? Number(process.env.AEGIS_TOOL_CACHE_TTL_MS ?? 5000);
    }

    async listTools(user: ZaruUser): Promise<AegisToolDefinition[]> {
        const cacheKey = user.securityContext;
        const cached = this.toolCache.get(cacheKey);
        const now = Date.now();
        if (cached && cached.expiresAt > now) {
            return cached.tools;
        }

        const discoveryResponse = await this.fetchImpl(this.toolDiscoveryUrl, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                'X-Zaru-Security-Context': user.securityContext
            }
        });

        if (discoveryResponse.ok) {
            const tools = normalizeToolList(await discoveryResponse.json());
            this.toolCache.set(cacheKey, {
                tools,
                expiresAt: now + this.cacheTtlMs
            });
            return tools;
        }

        if (discoveryResponse.status !== 404 && discoveryResponse.status !== 405) {
            throw new Error(`Tool discovery failed: ${discoveryResponse.status} ${await discoveryResponse.text()}`);
        }

        const result = await this.invokeJsonRpc(user, {
            jsonrpc: '2.0',
            id: 'tools-list',
            method: 'tools/list',
            params: {}
        });

        const tools = normalizeToolList(result);
        this.toolCache.set(cacheKey, {
            tools,
            expiresAt: now + this.cacheTtlMs
        });
        return tools;
    }

    async streamExecution(
        user: ZaruUser,
        executionId: string
    ): Promise<globalThis.Response> {
        const session = await this.getOrCreateSession(user);
        const url = resolveUrl(this.baseUrl, `/v1/executions/${executionId}/stream?token=${session.securityToken}`);

        const response = await this.fetchImpl(url, {
            method: 'GET',
            headers: {
                'Accept': 'text/event-stream',
                'Cache-Control': 'no-cache',
            },
        });

        if (response.status === 401) {
            this.sessionCache.delete(user.userId);
            const freshSession = await this.getOrCreateSession(user);
            const retryUrl = resolveUrl(this.baseUrl, `/v1/executions/${executionId}/stream?token=${freshSession.securityToken}`);
            return this.fetchImpl(retryUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                },
            });
        }

        return response;
    }

    async invokeTool(
        user: ZaruUser,
        name: string,
        args: Record<string, unknown>,
        id: string | number | null
    ): Promise<unknown> {
        return this.invokeJsonRpc(user, {
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: {
                name,
                arguments: args
            }
        });
    }

    private async invokeJsonRpc(user: ZaruUser, payload: JsonRpcRequest): Promise<unknown> {
        const session = await this.getOrCreateSession(user);
        const envelope = buildSmcpEnvelope(session.securityToken, payload, session.keyPair.privateKey);
        const response = await this.fetchImpl(resolveUrl(this.baseUrl, '/v1/smcp/invoke'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(envelope)
        });

        if (response.status === 401) {
            this.sessionCache.delete(user.userId);
            return this.invokeJsonRpcWithFreshSession(user, payload);
        }

        if (!response.ok) {
            throw new Error(`AEGIS invoke failed: ${response.status} ${await response.text()}`);
        }

        return normalizeToolCallResult(await response.json());
    }

    private async invokeJsonRpcWithFreshSession(user: ZaruUser, payload: JsonRpcRequest): Promise<unknown> {
        const session = await this.createSession(user);
        this.sessionCache.set(user.userId, session);
        const envelope = buildSmcpEnvelope(session.securityToken, payload, session.keyPair.privateKey);
        const response = await this.fetchImpl(resolveUrl(this.baseUrl, '/v1/smcp/invoke'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(envelope)
        });

        if (!response.ok) {
            throw new Error(`AEGIS invoke failed after re-attestation: ${response.status} ${await response.text()}`);
        }

        return normalizeToolCallResult(await response.json());
    }

    private async getOrCreateSession(user: ZaruUser): Promise<ZaruSmcpSession> {
        const existing = this.sessionCache.get(user.userId);
        if (existing && existing.securityContext === user.securityContext) {
            return existing;
        }

        const session = await this.createSession(user);
        this.sessionCache.set(user.userId, session);
        return session;
    }

    private async createSession(user: ZaruUser): Promise<ZaruSmcpSession> {
        const sessionId = createSessionId();
        const keyPair = createSessionKeyPair();
        const response = await this.fetchImpl(resolveUrl(this.baseUrl, '/v1/smcp/attest'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                user_id: user.userId,
                workload_id: `zaru:${user.userId}:${sessionId}`,
                security_context: user.securityContext,
                zaru_tier: user.tier,
                agent_public_key: keyPair.publicKeyRaw.toString('base64'),
                container_id: `zaru-mcp-server:${sessionId}`
            })
        });

        if (!response.ok) {
            throw new Error(`Attestation failed: ${response.status} ${await response.text()}`);
        }

        const body = await response.json() as AttestationResponse;
        if (!body.security_token) {
            throw new Error('Attestation response did not include security_token');
        }

        return {
            sessionId,
            securityToken: body.security_token,
            securityContext: user.securityContext,
            keyPair
        };
    }
}
