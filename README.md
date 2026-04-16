# Zaru MCP Server

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

An MCP-compliant gateway that proxies tool calls to the AEGIS orchestrator
via SEAL (Signed Envelope Attestation Layer) envelope signing. Also hosts
the canonical Zaru system prompts delivered through the `zaru.init` and
`zaru.mode` client-side tools.

Written in TypeScript. Runs on Node.js with Express.

## How It Works

The server does not implement individual tools. It discovers the tool
catalog from the AEGIS orchestrator and re-exposes it over standard MCP
transports. Every tool invocation is wrapped in a SEAL envelope --
cryptographically signed with an Ed25519 session key and authenticated
against the orchestrator's attestation endpoint.

Two tools are handled locally (never forwarded to AEGIS):

- **`zaru.init`** -- Activate the Zaru persona. Returns a system prompt
  and available tool list for a given conversation mode (`chat`, `agentic`,
  `workflow`, `execute`, `operator`). Defaults to `chat`.
- **`zaru.mode`** -- Switch conversation mode. Returns the updated system
  prompt and tool scope for the target mode.

## Architecture

```text
MCP Client ──► Zaru MCP Server ──► AEGIS Orchestrator
               (this repo)         (SEAL attestation + tool registry)
```

- **StreamableHTTP transport** (primary) -- `POST /mcp/v1`, `GET /mcp/v1`,
  `DELETE /mcp/v1`
- **SSE transport** (legacy) -- `GET /mcp/v1/sse`, `POST /mcp/v1/messages`
- **Execution event proxy** -- `GET /proxy/v1/executions/:executionId/stream`
  (SSE passthrough for the Zaru Glass Laboratory UI)
- **Health check** -- `GET /health`

### Authentication

Requests must include a token via `Authorization: Bearer <token>`,
`x-zaru-user-token` header, or `token` query parameter.

Two authentication methods are supported:

| Method | Token format | Validation |
| --- | --- | --- |
| Keycloak JWT | Standard JWT | Verified against Keycloak JWKS; multi-realm |
| AEGIS API key | `aegis_` prefix | Validated via orchestrator API key EP |

### SEAL Protocol Flow

1. **Attestation** -- The server creates an Ed25519 key pair, sends the
   public key to `POST /v1/seal/attest` on the orchestrator, and receives
   a `security_token`.
2. **Envelope signing** -- Each `tools/call` request is wrapped in a SEAL
   envelope containing the JSON-RPC payload, security token, timestamp,
   and Ed25519 signature.
3. **Invocation** -- The signed envelope is sent to `POST /v1/seal/invoke`
   on the orchestrator.
4. **Session management** -- Sessions are cached per user and automatically
   re-attested on expiry or rejection.

## Connecting from External MCP Clients

### Claude Code

```bash
claude mcp add zaru --transport http https://mcp.myzaru.com/mcp/v1 \
  --header "Authorization: Bearer YOUR_API_KEY"
```

### Full setup guide

<https://docs.100monkeys.ai/docs/zaru/mcp-client-setup>

## Development

```bash
cd zaru-mcp-server
npm install
npm run build   # compile TypeScript
npm test        # run test suite
```

### Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Server listen port |
| `AEGIS_ORCHESTRATOR_URL` | `localhost:8088` | Orchestrator base URL |
| `JWKS_URI` | _(see below)_ | Keycloak JWKS endpoint |
| `AEGIS_TOOL_DISCOVERY_URL` | _(auto)_ | Tool discovery override |
| `AEGIS_TOOL_CACHE_TTL_MS` | `5000` | Tool list cache TTL (ms) |
| `BYPASS_AUTH` | _(unset)_ | `true` to skip auth (dev) |
| `CONTAINER_ID` | `$HOSTNAME` | SEAL attestation identifier |

`JWKS_URI` defaults to
`http://localhost:8180/realms/zaru-consumer/protocol/openid-connect/certs`.
`AEGIS_TOOL_DISCOVERY_URL` defaults to
`<AEGIS_ORCHESTRATOR_URL>/v1/seal/tools`.

## Repository Structure

```text
aegis-mcp-tools/
├── .github/
│   └── workflows/
│       ├── ci.yml
│       ├── docker-publish.yml
│       ├── npm-publish.yml
│       └── security.yml
├── zaru-mcp-server/
│   ├── src/
│   │   ├── index.ts                  # Express server entry point
│   │   ├── mcp/
│   │   │   ├── index.ts              # JSON-RPC request handler
│   │   │   ├── orchestrator-client.ts # SEAL attestation + tool proxy client
│   │   │   ├── seal.ts               # Ed25519 key pair and envelope signing
│   │   │   ├── sse.ts                # SSE transport (legacy)
│   │   │   ├── streamable-http.ts    # StreamableHTTP transport (primary)
│   │   │   └── types.ts              # Shared type definitions
│   │   ├── middleware/
│   │   │   └── auth.ts               # JWT + API key authentication
│   │   └── prompts/
│   │       └── index.ts              # Zaru system prompts
│   ├── test/
│   │   ├── auth.test.ts
│   │   ├── normalize-tool-result.test.ts
│   │   ├── orchestrator-client.test.ts
│   │   ├── proxy-stream.test.ts
│   │   └── seal.test.ts
│   ├── package.json
│   ├── package-lock.json
│   └── tsconfig.json
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE
├── SECURITY.md
└── README.md
```

## License

AGPL-3.0 -- See [LICENSE](LICENSE) for details.

## Links

- [AEGIS Orchestrator](https://github.com/100monkeys-ai/aegis-orchestrator)
- [Documentation](https://docs.100monkeys.ai)
- [Zaru](https://myzaru.com)
- [MCP Specification](https://modelcontextprotocol.io)
