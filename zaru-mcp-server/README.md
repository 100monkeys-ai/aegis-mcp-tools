# Zaru MCP Server

`zaru-mcp-server` is the Streamable HTTP MCP bridge that lets LibreChat talk to AEGIS through SMCP.

## What It Does

- Accepts MCP JSON-RPC on `POST /mcp/v1/`
- Validates the LibreChat user token from `X-Zaru-User-Token`
- Resolves the user's `zaru_tier` claim to an AEGIS `SecurityContext`
- Discovers the current AEGIS tool inventory from the orchestrator instead of hardcoding tools locally
- Attests an ephemeral Ed25519 session and forwards `tools/call` requests as SMCP envelopes to AEGIS

This server no longer publishes local `aegis.*` helper tools. The `aegis.*` namespace is reserved for the real AEGIS tool surface exposed through the orchestrator.

## Endpoints

- `POST /mcp/v1/`
  - `initialize`
  - `tools/list`
  - `tools/call`
- `GET /health`

## Environment

```env
PORT=3000
JWKS_URI=http://keycloak:8080/realms/zaru-consumer/protocol/openid-connect/certs
AEGIS_ORCHESTRATOR_URL=http://aegis-node:8088

# Optional override if tool discovery is exposed at a non-default path.
AEGIS_TOOL_DISCOVERY_URL=http://aegis-node:8088/v1/smcp/tools

# Optional cache for orchestrator tool discovery responses.
AEGIS_TOOL_CACHE_TTL_MS=5000

# Local testing only.
BYPASS_AUTH=false
```

## Auth Contract

- Zaru expects the incoming LibreChat JWT in `X-Zaru-User-Token`
- JWT verification is performed against `JWKS_URI`
- `sub` becomes the Zaru user identity
- `zaru_tier` must resolve to one of `free`, `pro`, or `enterprise`
- Tiers are mapped to `zaru-free`, `zaru-pro`, and `zaru-enterprise`

## SMCP Contract

- Attestation: `POST ${AEGIS_ORCHESTRATOR_URL}/v1/smcp/attest`
- Invocation: `POST ${AEGIS_ORCHESTRATOR_URL}/v1/smcp/invoke`
- Discovery: `GET ${AEGIS_TOOL_DISCOVERY_URL}` with fallback to orchestrator-backed `tools/list`

Every tool invocation is wrapped in an SMCP envelope with:

- `protocol: "smcp/v1"`
- `security_token`
- `signature`
- `payload`
- `timestamp`

The envelope signature is computed from the canonical SMCP message:

```json
{
  "payload": { "...": "..." },
  "security_token": "<JWT>",
  "timestamp": 1711024496
}
```

Keys are sorted lexicographically before signing.

## Development

```bash
npm install
npm run build
npm test
```
