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
  (Glass Laboratory). `executionId` must be a UUID; any other value
  returns 400 and is not forwarded

### Health

- `GET /health` -- Health check

## Environment Variables

- **`PORT`** (default `3000`) --
  Server listen port
- **`AEGIS_ORCHESTRATOR_URL`** (default `http://localhost:8088`)
  -- Base URL of the AEGIS orchestrator
- **`JWKS_URI`** (default
  `http://localhost:8180/realms/zaru-consumer/protocol/openid-connect/certs`)
  -- Keycloak JWKS endpoint for JWT verification. Must end in
  `/protocol/openid-connect/certs`; the issuer it serves is derived by
  removing that suffix and is always trusted
- **`KEYCLOAK_SYSTEM_ISSUER`** (default
  `<JWKS_URI host>/realms/aegis-system`) -- Issuer of the aegis-system
  realm. Never trusted: a token it issued is refused 401 before any key
  set is fetched (Zaru ADR-0050 D6)
- **`KEYCLOAK_TRUSTED_ISSUERS`** (default empty) -- Comma-separated
  list of further exact issuer URLs to trust, for example an enterprise
  realm `https://auth.example.com/realms/tenant-acme`. Each is verified
  against `<issuer>/protocol/openid-connect/certs`
- **`AEGIS_TOOL_DISCOVERY_URL`** (default
  `${AEGIS_ORCHESTRATOR_URL}/v1/seal/tools`) --
  Override tool discovery endpoint
- **`AEGIS_TOOL_CACHE_TTL_MS`** (default `5000`) --
  Cache TTL for tool discovery responses (ms)
- **`BYPASS_AUTH`** (default `false`) --
  Skip JWT/API-key verification (local testing only)
- **`ZARU_CLIENT_URL`** (default `http://zaru-client:3000`) --
  URL by which zaru-mcp-server reaches zaru-client over the in-pod
  network for Zaru User Memory read/write

## Authentication

The server accepts tokens via three mechanisms
(checked in order):

1. `X-Zaru-User-Token` header
2. `Authorization: Bearer <token>` header
3. `token` query parameter (for SSE GET requests)

**Keycloak JWT** -- the token's `iss` must exactly match one of the
trusted issuers fixed at startup (the `JWKS_URI` realm and
`KEYCLOAK_TRUSTED_ISSUERS`). A token from any other issuer is refused
before any key set is fetched; a token of the aegis-system realm
(`KEYCLOAK_SYSTEM_ISSUER`) is refused 401. The
signature is verified against that issuer's JWKS, with key rotation
handled per issuer. The `sub` claim becomes the user identity;
`zaru_tier` resolves to a `SecurityContext` (`zaru-free`,
`zaru-pro`, `zaru-business`, `zaru-enterprise`). An `aegis_role`
claim grants nothing: no JWT carries the operator surface.

**AEGIS API key** -- tokens prefixed with `aegis_` are validated
against `POST ${AEGIS_ORCHESTRATOR_URL}/v1/api-keys/validate`.
The orchestrator hashes the key, looks it up, and returns the
owner identity and role. A key's stored role grants nothing here: the
key is served the operator context (`aegis-system-operator`, the
`operator` mode) only while the answer carries
`operator_escalation: { expires_at }` with `expires_at` in the future
and an `aegis_role` of `aegis:admin` or `aegis:operator`, an escalation
the key gained by `zaru.operator.escalate` with a code from Zaru Web's
operator page (Zaru ADR-0050 D3 to D5; AEGIS ADR-129).

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

On the Cloudflare Worker, a waiting tool (a name ending in `.wait`) is
forwarded with `timeout_seconds` of at most 45, whatever the caller sent; a
smaller value is honoured. If the execution is still running at that bound,
the result says so (`still_running: true`, status, iteration count or state,
`waited_seconds`) and that repeating the same call continues the wait. The
container keeps the orchestrator's own wait.

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
