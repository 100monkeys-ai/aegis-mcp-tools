# AEGIS MCP Tools

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Secure MCP gateway that proxies tool calls to the**
> **AEGIS orchestrator via SMCP envelope signing**

This repository contains the **zaru-mcp-server**, an
MCP-compliant gateway/proxy that securely forwards
`tools/list` and `tools/call` requests to the AEGIS
orchestrator. It does not implement individual tools —
instead, it exposes whatever tools are registered in the
orchestrator, handling authentication, SMCP envelope
signing, and transport (SSE and Streamable HTTP).

## Purpose

The zaru-mcp-server addresses the "Supply Chain Risk"
identified in OpenClaw deployments by providing:

1. **Secure Gateway**: All tool calls are authenticated
   and signed via SMCP envelopes
2. **Sandboxed Execution**: Tools run with minimal
   permissions on the orchestrator side
3. **Audit Trail**: All tool invocations are logged immutably
4. **Resource Limits**: CPU, memory, and network caps enforced by the orchestrator
5. **Fail-Safe Defaults**: Tools default to read-only operations

## Available Tools (Orchestrator Catalog)

> **Note:** The tool catalog below is served by the
> AEGIS orchestrator, not implemented in this
> repository. This repo contains the MCP gateway
> (`zaru-mcp-server`) that securely proxies
> `tools/list` and `tools/call` requests to the
> orchestrator via SMCP envelope signing. The tools
> listed here describe the orchestrator's tool
> catalog for reference.

### Core Tools (Maintained by AEGIS Core Team)

#### **filesystem** - Local File Access

- **Description**: Read/write files with strict path restrictions
- **Permissions**: Configurable chroot jail
- **Status**: Production Ready

#### **web-search** - Internet Search

- **Description**: Search via multiple providers (DuckDuckGo, Brave, Google)
- **Permissions**: Egress to search APIs only
- **Status**: Production Ready

#### **browser** - Web Automation

- **Description**: Headless browser control via Playwright
- **Permissions**: Sandboxed Chromium with network policies
- **Status**: Beta

#### **database** - SQL Query Interface

- **Description**: Safe SQL execution with query analysis
- **Permissions**: Read-only by default, configurable write
- **Status**: Production Ready

### Integration Tools

#### **gmail** - Email Management

- **Description**: Read/send emails via Gmail API
- **Permissions**: OAuth2 with scope restrictions
- **Status**: Production Ready

#### **github** - Repository Operations

- **Description**: Read repos, create PRs, manage issues
- **Permissions**: Fine-grained access tokens
- **Status**: Production Ready

#### **slack** - Team Communication

- **Description**: Send messages, read channels
- **Permissions**: Bot token with channel restrictions
- **Status**: Production Ready

#### **discord** - Community Management

- **Description**: Bot interactions and webhooks
- **Permissions**: Limited to configured guilds
- **Status**: Production Ready

### Utility Tools

#### **shell** - Command Execution

- **Description**: Run shell commands in isolated environment
- **Permissions**: Allowlist of approved commands
- **Status**: Advanced Users Only

#### **http** - HTTP Client

- **Description**: Make HTTP requests with policies
- **Permissions**: Domain allowlist + rate limiting
- **Status**: Production Ready

#### **vector-db** - Memory Storage

- **Description**: Cortex integration for persistent memory
- **Permissions**: Agent-scoped data isolation
- **Status**: Production Ready

## Security Model

Every tool in this repository adheres to AEGIS security principles:

```yaml
# Example: Filesystem Tool Security Manifest
tool: filesystem
version: "1.0"
security:
  permissions:
    filesystem:
      read: ["/data/inputs"]
      write: ["/data/outputs"]
    network: deny-all
  resources:
    max_memory: "256MB"
    max_cpu: "0.5"
    timeout: "30s"
  audit:
    log_all_calls: true
    include_args: true
    immutable: true
```

### Security Guarantees

1. **Principle of Least Privilege**: Tools request minimum permissions
2. **Fail-Safe Defaults**: All operations denied unless explicitly allowed
3. **Input Validation**: All parameters sanitized and validated
4. **Rate Limiting**: Prevents abuse via request throttling
5. **Audit Logging**: Every action logged for compliance

## Usage

### With AEGIS Orchestrator

```yaml
# agent.yaml
version: "1.0"
agent:
  name: "my-agent"
  
tools:
  - "mcp:filesystem@aegis/mcp-tools"
  - "mcp:web-search@aegis/mcp-tools"
  
permissions:
  filesystem:
    read: ["/data"]
  network:
    allow: ["duckduckgo.com"]
```

### With AEGIS SDK (Python)

```python
from aegis import Agent

agent = Agent.from_manifest("agent.yaml")

# Tools are automatically loaded and sandboxed
result = await agent.execute("Search the web and save results")
```

### With AEGIS SDK (TypeScript)

```typescript
import { Agent } from '@aegis/sdk';

const agent = await Agent.fromManifest('agent.yaml');

// Tools inherit agent's security context
const result = await agent.execute('Search the web and save results');
```

## Development

### Registering a New Tool

New tools are registered in the **AEGIS orchestrator**,
not created as directories in this repository. The
zaru-mcp-server automatically exposes any tools
registered in the orchestrator via its `tools/list`
and `tools/call` proxy endpoints.

To add a new tool to the AEGIS platform:

1. **Define the tool schema** in the orchestrator's tool registry
2. **Implement the tool handler** in the orchestrator codebase
3. **Add security manifest** with permissions, resource limits, and audit config
4. **Write tests** in the orchestrator's test suite
5. **Submit PR with security review checklist** to the orchestrator repo

The zaru-mcp-server will automatically surface the
new tool to MCP clients once it is registered in
the orchestrator.

### Security Review Checklist

- [ ] Input validation on all parameters
- [ ] Resource limits defined
- [ ] Network allowlist configured
- [ ] Filesystem access minimized
- [ ] Audit logging implemented
- [ ] Error messages don't leak sensitive data
- [ ] Rate limiting configured
- [ ] Documentation includes threat model

## Repository Structure

```text
aegis-mcp-tools/
├── .github/
│   ├── dependabot.yml
│   └── workflows/
├── zaru-mcp-server/          # MCP gateway/proxy server
│   ├── src/
│   │   ├── index.ts          # Server entry point
│   │   ├── mcp/
│   │   │   ├── index.ts      # MCP protocol handler
│   │   │   ├── orchestrator-client.ts  # AEGIS orchestrator client
│   │   │   ├── smcp.ts       # SMCP envelope signing
│   │   │   ├── sse.ts        # SSE transport
│   │   │   ├── streamable-http.ts      # Streamable HTTP transport
│   │   │   └── types.ts      # Shared type definitions
│   │   └── middleware/
│   │       └── auth.ts       # Authentication middleware
│   ├── test/
│   │   ├── auth.test.ts
│   │   ├── orchestrator-client.test.ts
│   │   └── smcp.test.ts
│   ├── dist/                  # Compiled output
│   ├── Dockerfile
│   ├── package.json
│   ├── package-lock.json
│   ├── tsconfig.json
│   └── README.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE
├── SECURITY.md
└── README.md
```

## Installation

### From AEGIS Registry (Recommended)

```bash
aegis tools install filesystem web-search gmail
```

### From Source

```bash
git clone https://github.com/100monkeys-ai/aegis-mcp-tools.git
cd aegis-mcp-tools/zaru-mcp-server
npm install
npm run build
```

### Docker

```bash
docker pull aegis/mcp-tools:latest
```

## Contributing

We welcome contributions of new tools, but all submissions must pass security review:

1. Read [CONTRIBUTING.md](CONTRIBUTING.md)
2. Review [SECURITY.md](SECURITY.md) for security requirements
3. Fork the repository
4. Create a feature branch
5. Implement tool with security manifest
6. Add comprehensive tests
7. Submit PR with security checklist

## Security Policy

Found a security vulnerability? Please **DO NOT** open a public issue.

Email: <security@100monkeys.ai> (PGP key available)

See [SECURITY.md](SECURITY.md) for our responsible disclosure policy.

## Tool Compatibility Matrix

| Tool | MCP Version | AEGIS Version | Python | TypeScript | Rust |
| ------ | ------------ | --------------- | -------- | ------------ | ------ |
| filesystem | 1.0 | ≥0.1.0 | ✅ | ✅ | ✅ |
| web-search | 1.0 | ≥0.1.0 | ✅ | ✅ | ✅ |
| browser | 1.0 | ≥0.2.0 | ✅ | ✅ | ⚠️ |
| database | 1.0 | ≥0.1.0 | ✅ | ✅ | ✅ |
| gmail | 1.0 | ≥0.1.0 | ✅ | ✅ | ❌ |
| github | 1.0 | ≥0.1.0 | ✅ | ✅ | ⚠️ |
| slack | 1.0 | ≥0.1.0 | ✅ | ✅ | ❌ |

## License

MIT License - See [LICENSE](LICENSE) for details.

## Links

- **Main Repository**: [github.com/100monkeys-ai/aegis-orchestrator](https://github.com/100monkeys-ai/aegis-orchestrator)
- **Documentation**: [docs.100monkeys.ai](https://docs.100monkeys.ai)
- **MCP Specification**: [modelcontextprotocol.io](https://modelcontextprotocol.io)
- **Security Policy**: [SECURITY.md](SECURITY.md)

---

**AEGIS MCP Tools** - Secure tool execution for autonomous agents
