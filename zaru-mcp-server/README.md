# Zaru MCP Server

Node.js/Express MCP gateway that authenticates clients, proxies
tool calls to the AEGIS orchestrator via SEAL envelope signing,
and hosts the canonical Zaru system prompts.

## Features

- **StreamableHTTP + SSE MCP transports** --
  StreamableHTTP (primary) with session management;
  SSE (legacy) for backward-compatible clients
- **Dual authentication** --
  Keycloak JWT (Zaru consumer client) or AEGIS API key
  (`aegis_`-prefixed tokens validated against the orchestrator)
  for external clients like Claude Code
- **SEAL protocol tool invocation** --
  ephemeral Ed25519 session keypairs, attestation against the
  orchestrator, and cryptographically signed envelopes for every
  tool call
- **`zaru.init`** --
  activate the Zaru persona with mode-specific system prompts
  (chat, agentic, workflow, execute, operator)
- **`zaru.mode`** --
  switch conversation modes at runtime; returns the updated
  system prompt and available tool scope
- **Execution event streaming proxy** --
  pipes SSE execution events from the orchestrator for Glass
  Laboratory visualization
- **Tool discovery and caching** --
  fetches the AEGIS tool catalog from the orchestrator
  (filtered by the caller's `SecurityContext`) with a
  configurable TTL cache (default 5 s)

## Endpoints

### StreamableHTTP (Primary)

- `POST /mcp/v1` --
  Handle MCP JSON-RPC messages (tool calls, initialization)
- `GET /mcp/v1` --
  Server-initiated SSE push (delegates to session transport,
  or 405 if no session)
- `DELETE /mcp/v1` --
  Clean up an MCP session by `Mcp-Session-Id` header

### SSE (Legacy)

- `GET /mcp/v1/sse` --
  Establish SSE session; sends `endpoint` event with POST URL
- `POST /mcp/v1/messages?sessionId=<id>` --
  Receive JSON-RPC messages for an SSE session

### Execution Streaming

- `GET /proxy/v1/executions/:executionId/stream` --
  Proxy SSE execution events from the orchestrator
  (Glass Laboratory)

### Health

- `GET /health` -- Health check

## Environment Variables

- **`PORT`** (default `3000`) --
  Server listen port
- **`AEGIS_ORCHESTRATOR_URL`** (default `http://localhost:8088`)
  -- Base URL of the AEGIS orchestrator
- **`JWKS_URI`** (default
  `http://localhost:8180/realms/zaru-consumer/protocol/openid-connect/certs`)
  -- Keycloak JWKS endpoint for JWT verification
- **`AEGIS_TOOL_DISCOVERY_URL`** (default
  `${AEGIS_ORCHESTRATOR_URL}/v1/seal/tools`) --
  Override tool discovery endpoint
- **`AEGIS_TOOL_CACHE_TTL_MS`** (default `5000`) --
  Cache TTL for tool discovery responses (ms)
- **`BYPASS_AUTH`** (default `false`) --
  Skip JWT/API-key verification (local testing only)

## Authentication

The server accepts tokens via three mechanisms
(checked in order):

1. `X-Zaru-User-Token` header
2. `Authorization: Bearer <token>` header
3. `token` query parameter (for SSE GET requests)

**Keycloak JWT** -- verified against JWKS_URI with per-issuer
key rotation caching. The `sub` claim becomes the user identity;
`zaru_tier` resolves to a `SecurityContext` (`zaru-free`,
`zaru-pro`, `zaru-business`, `zaru-enterprise`). Tokens with an
`aegis_role` claim (`admin`, `operator`, `readonly`) are treated
as operator identities.

**AEGIS API key** -- tokens prefixed with `aegis_` are validated
against `POST ${AEGIS_ORCHESTRATOR_URL}/v1/api-keys/validate`.
The orchestrator hashes the key, looks it up, and returns the
owner identity and role.

## SEAL Contract

### Attestation

```text
POST ${AEGIS_ORCHESTRATOR_URL}/v1/seal/attest
```

The server generates an ephemeral Ed25519 keypair per session,
sends the public key to the orchestrator along with the user
identity and security context, and receives a `security_token`
JWT used for subsequent invocations.

### Tool Invocation

```text
POST ${AEGIS_ORCHESTRATOR_URL}/v1/seal/invoke
```

Every tool call is wrapped in a SEAL envelope:

```json
{
  "protocol": "seal/v1",
  "security_token": "<JWT from attestation>",
  "signature": "<base64 Ed25519 signature>",
  "payload": { "<MCP JSON-RPC>" },
  "timestamp": "<ISO 8601 UTC>"
}
```

The signature is computed over a canonical message with
lexicographically sorted keys, where `timestamp` is Unix epoch
seconds:

```json
{"payload":{...},"security_token":"<JWT>","timestamp":1711024496}
```

### Tool Discovery

```text
GET ${AEGIS_TOOL_DISCOVERY_URL}
Header: X-Zaru-Security-Context: zaru-<tier>
```

Falls back to JSON-RPC `tools/list` via SEAL invoke if the
discovery endpoint returns 404/405.

## Docker

```bash
docker build -t zaru-mcp-server .
docker run -p 3000:3000 zaru-mcp-server
```

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
