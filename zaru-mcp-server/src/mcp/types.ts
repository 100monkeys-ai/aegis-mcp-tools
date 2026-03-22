export interface JsonRpcRequest {
    jsonrpc: string;
    id?: string | number | null;
    method: string;
    params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
    jsonrpc: "2.0";
    id: string | number | null;
    result: unknown;
}

export interface JsonRpcFailure {
    jsonrpc: "2.0";
    id: string | number | null;
    error: {
        code: number;
        message: string;
    };
}

export interface AegisToolDefinition {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

export interface SmcpEnvelope {
    protocol: "smcp/v1";
    security_token: string;
    signature: string;
    payload: JsonRpcRequest;
    timestamp: string;
}
