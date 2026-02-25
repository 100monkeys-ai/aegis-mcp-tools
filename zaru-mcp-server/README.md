# Zaru MCP Server

Zaru MCP Server is an intermediate Model Context Protocol (MCP) bridge that enables chat interfaces, like LibreChat, to securely connect to the [AEGIS Orchestrator](https://github.com/100monkeys-ai/aegis-orchestrator) using the Secure Model Context Protocol (SMCP).

## Architecture & Purpose

Many LLM platforms (like LibreChat) support connecting to standard MCP servers via HTTP/SSE. However, AEGIS operates on a highly secure, Zero-Trust protocol known as **SMCP** (Secure MCP), which requires Ed25519 cryptographic signatures and session attestation.

Zaru MCP Server acts as the translation layer:

1. **Frontend / Ingress:** Exposes standard JSON-RPC 2.0 endpoints that LibreChat expects.
2. **Identity Bridging:** Validates LibreChat's JWTs (`Authorization` header) and extracts user information (e.g., `X-LibreChat-User-ID`, `X-Zaru-Tier`).
3. **SMCP Attestation:** Initializes a secure session with AEGIS by generating an ephemeral Ed25519 keypair and sending an `AttestationRequest`.
4. **Invocation Forwarding:** Packages MCP tool calls (like `aegis.execute`) into signed `SmcpEnvelope`s and forwards them to AEGIS.

## Project Structure

- `src/index.ts`: The main Express server entry point.
- `src/middleware/auth.ts`: Handles LibreChat JWT validation and user identity extraction.
- `src/mcp/index.ts`: The core MCP request handler, including SMCP attestation and tool routing.

## Prerequisites

- Node.js (v18 or higher recommended)
- TypeScript
- An instance of AEGIS Orchestrator running and reachable over HTTP/REST.

## Installation

```bash
npm install
npm run build
```

## Configuration

Zaru MCP Server requires several environment variables to operate correctly. Create a `.env` file in the root directory:

```env
# The port the Express server will run on (default: 3000)
PORT=3000

# URI to fetch JSON Web Key Sets for validating LibreChat JWTs
JWKS_URI=http://your-auth-provider/.well-known/jwks.json

# Optional: Fallback secret for local development (if JWKS signature validation fails)
DEV_JWT_SECRET=your_local_secret

# The URL of the AEGIS Orchestrator HTTP endpoint 
# (Should point to where AEGIS exposes /v1/smcp/...)
AEGIS_ORCHESTRATOR_URL=http://localhost:8088

# Set to "true" to bypass LibreChat JWT authentication entirely (for local testing only)
BYPASS_AUTH=false
```

## Running the Server

### Development Mode

Run the server with hot-reloading using `nodemon` and `ts-node`:

```bash
npm run dev
```

### Production Mode

Compile the TypeScript code and run the compiled JavaScript:

```bash
npm run build
npm start
```

## Endpoints

### `GET /health`

A simple health check endpoint to verify the server is running.

### `POST /mcp/v1/`

The primary MCP endpoint. It accepts standard JSON-RPC 2.0 requests:

- `initialize`: Returns server capabilities.
- `tools/list`: Returns the list of tools available through AEGIS (e.g., `aegis.execute`).
- `tools/call`: Executes a specified tool by wrapping it in an SMCP envelope and forwarding it to AEGIS.

## Security Considerations

- **Ephemeral Keys:** Zaru generates a new Ed25519 keypair for each active user session. These keys are never persisted to disk.
- **JWKS Validation:** In production, Zaru strictly validates the incoming JWTs against the configured `JWKS_URI` to ensure requests originated from an authorized LibreChat instance.

## License

MIT
