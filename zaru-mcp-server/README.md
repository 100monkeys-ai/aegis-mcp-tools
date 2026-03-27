# Zaru MCP Server

MCP bridge that lets the Zaru client talk to AEGIS through SMCP. Supports StreamableHTTP (primary) and SSE (legacy) transports.

## What It Does

- Accepts MCP JSON-RPC over StreamableHTTP at `/mcp/v1` (primary) and SSE at `/mcp/v1/sse` (legacy)
- Validates the Zaru client JWT from `Authorization: Bearer` header or `X-Zaru-User-Token`
- Resolves the user's `zaru_tier` claim to an AEGIS `SecurityContext`
- Discovers the current AEGIS tool inventory from the orchestrator (not hardcoded locally)
- Attests an ephemeral Ed25519 session and forwards `tools/call` requests as SMCP envelopes to AEGIS
- Proxies execution event streams from the orchestrator for Glass Lab visualization

The orchestrator owns the `aegis.*` tool surface and filters it by the caller's tier-derived `SecurityContext`, so `zaru-pro`, `zaru-business`, and `zaru-enterprise` surface the full management set while `zaru-free` remains restricted.

## Endpoints

### StreamableHTTP (Primary)

- `POST /mcp/v1` — Handle MCP JSON-RPC messages (tool calls, initialization)
- `GET /mcp/v1` — Server-initiated push (currently 405)
- `DELETE /mcp/v1` — Clean up MCP session

### SSE (Legacy)

- `GET /mcp/v1/sse` — Establish SSE session; sends `endpoint` event with POST URL
- `POST /mcp/v1/messages?sessionId=<id>` — Receive JSON-RPC messages for a session

### Execution Streaming

- `GET /proxy/v1/executions/:executionId/stream` — Proxy SSE execution events from the orchestrator (for Glass Lab)

### Health

- `GET /health` — Health check

## Environment

```env
PORT=3000
JWKS_URI=http://keycloak:8080/realms/zaru-consumer/protocol/openid-connect/certs
AEGIS_ORCHESTRATOR_URL=http://aegis-node:8088

# Optional: override tool discovery path
AEGIS_TOOL_DISCOVERY_URL=http://aegis-node:8088/v1/smcp/tools

# Optional: cache TTL for tool discovery responses
AEGIS_TOOL_CACHE_TTL_MS=5000

# Local testing only
BYPASS_AUTH=false
```

## Auth Contract

The server accepts JWTs via two mechanisms (checked in order):

1. `X-Zaru-User-Token` header (custom header)
2. `Authorization: Bearer <token>` header (standard HTTP auth)
3. `token` query parameter (for SSE GET requests)

JWT verification is performed against `JWKS_URI` (Keycloak JWKS endpoint):

- `sub` becomes the Zaru user identity
- `zaru_tier` must resolve to one of `free`, `pro`, `business`, or `enterprise`
- Tiers map to SecurityContexts: `zaru-free`, `zaru-pro`, `zaru-business`, `zaru-enterprise`

## SMCP Contract

### Attestation

```text
POST ${AEGIS_ORCHESTRATOR_URL}/v1/smcp/attest
```

Request body:

```json
{
  "agent_public_key": "<base64-encoded 32-byte Ed25519 public key>",
  "user_id": "<keycloak-sub>",
  "workload_id": "zaru:<userId>:<sessionId>",
  "security_context": "zaru-<tier>",
  "zaru_tier": "<tier>",
  "container_id": "zaru-mcp-server:<sessionId>"
}
```

Response: `{ "security_token": "<JWT>" }`

### Tool Invocation

```text
POST ${AEGIS_ORCHESTRATOR_URL}/v1/smcp/invoke
```

Every tool invocation is wrapped in an SMCP envelope:

```json
{
  "protocol": "smcp/v1",
  "security_token": "<JWT from attestation>",
  "signature": "<base64-encoded Ed25519 signature>",
  "payload": { "<MCP JSON-RPC>" },
  "timestamp": "<ISO 8601 UTC>"
}
```

### Tool Discovery

```text
GET ${AEGIS_TOOL_DISCOVERY_URL}
Header: X-Zaru-Security-Context: zaru-<tier>
```

Fallback: JSON-RPC `tools/list` via SMCP invoke.

### Canonical Message Format

The signature is computed over a canonical message with lexicographically sorted keys:

```json
{"payload":{"..."},"security_token":"<JWT>","timestamp":1711024496}
```

Where `timestamp` is Unix epoch seconds derived from the ISO 8601 timestamp.

## Development

```bash
npm install
npm run build
npm test
```
