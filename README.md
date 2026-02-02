# AEGIS MCP Tools

[![License](https://img.shields.io/badge/license-BSL%201.1-blue.svg)](LICENSE)

> **Curated, security-hardened Model Context Protocol (MCP) tool implementations for AEGIS**

This repository provides vetted and sandboxed MCP server implementations that integrate safely with the AEGIS orchestrator. Unlike community tools, these implementations include strict security controls, resource limits, and audit logging.

## 🎯 Purpose

AEGIS addresses the "Supply Chain Risk" identified in OpenClaw deployments by providing:

1. **Vetted Tools**: Each MCP server is security-reviewed and tested
2. **Sandboxed Execution**: Tools run with minimal permissions
3. **Audit Trail**: All tool invocations are logged immutably
4. **Resource Limits**: CPU, memory, and network caps enforced
5. **Fail-Safe Defaults**: Tools default to read-only operations

## 📦 Available Tools

### Core Tools (Maintained by AEGIS Core Team)

#### **filesystem** - Local File Access

- **Description**: Read/write files with strict path restrictions
- **Permissions**: Configurable chroot jail
- **Status**: ✅ Production Ready

#### **web-search** - Internet Search

- **Description**: Search via multiple providers (DuckDuckGo, Brave, Google)
- **Permissions**: Egress to search APIs only
- **Status**: ✅ Production Ready

#### **browser** - Web Automation

- **Description**: Headless browser control via Playwright
- **Permissions**: Sandboxed Chromium with network policies
- **Status**: 🚧 Beta

#### **database** - SQL Query Interface

- **Description**: Safe SQL execution with query analysis
- **Permissions**: Read-only by default, configurable write
- **Status**: ✅ Production Ready

### Integration Tools

#### **gmail** - Email Management

- **Description**: Read/send emails via Gmail API
- **Permissions**: OAuth2 with scope restrictions
- **Status**: ✅ Production Ready

#### **github** - Repository Operations

- **Description**: Read repos, create PRs, manage issues
- **Permissions**: Fine-grained access tokens
- **Status**: ✅ Production Ready

#### **slack** - Team Communication

- **Description**: Send messages, read channels
- **Permissions**: Bot token with channel restrictions
- **Status**: ✅ Production Ready

#### **discord** - Community Management

- **Description**: Bot interactions and webhooks
- **Permissions**: Limited to configured guilds
- **Status**: ✅ Production Ready

### Utility Tools

#### **shell** - Command Execution

- **Description**: Run shell commands in isolated environment
- **Permissions**: Allowlist of approved commands
- **Status**: ⚠️ Advanced Users Only

#### **http** - HTTP Client

- **Description**: Make HTTP requests with policies
- **Permissions**: Domain allowlist + rate limiting
- **Status**: ✅ Production Ready

#### **vector-db** - Memory Storage

- **Description**: Cortex integration for persistent memory
- **Permissions**: Agent-scoped data isolation
- **Status**: ✅ Production Ready

## 🔐 Security Model

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

## 📖 Usage

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

## 🔧 Development

### Creating a New Tool

1. **Define the tool interface** (`tools/my-tool/schema.json`)
2. **Implement the MCP server** (`tools/my-tool/server.py` or `.ts`)
3. **Add security manifest** (`tools/my-tool/security.yaml`)
4. **Write tests** (`tools/my-tool/tests/`)
5. **Submit PR with security review checklist**

### Security Review Checklist

- [ ] Input validation on all parameters
- [ ] Resource limits defined
- [ ] Network allowlist configured
- [ ] Filesystem access minimized
- [ ] Audit logging implemented
- [ ] Error messages don't leak sensitive data
- [ ] Rate limiting configured
- [ ] Documentation includes threat model

## 📂 Repository Structure

```markdown
aegis-mcp-tools/
├── tools/
│   ├── filesystem/         # Core tools
│   ├── web-search/
│   ├── browser/
│   ├── database/
│   ├── gmail/              # Integration tools
│   ├── github/
│   ├── slack/
│   ├── discord/
│   ├── shell/              # Utility tools
│   ├── http/
│   └── vector-db/
├── lib/
│   ├── security/           # Security wrappers
│   ├── audit/              # Logging utilities
│   └── validators/         # Input validation
├── schemas/                # MCP protocol schemas
├── tests/                  # Integration tests
├── docs/                   # Tool documentation
│   ├── SECURITY.md
│   └── CONTRIBUTING.md
└── README.md
```

## 🚀 Installation

### From AEGIS Registry (Recommended)

```bash
aegis tools install filesystem web-search gmail
```

### From Source

```bash
git clone https://github.com/aent-ai/aegis-mcp-tools.git
cd aegis-mcp-tools
aegis tools install --local ./tools
```

### Docker

```bash
docker pull aegis/mcp-tools:latest
```

## 🤝 Contributing

We welcome contributions of new tools, but all submissions must pass security review:

1. Read [CONTRIBUTING.md](CONTRIBUTING.md)
2. Review [SECURITY.md](SECURITY.md) for security requirements
3. Fork the repository
4. Create a feature branch
5. Implement tool with security manifest
6. Add comprehensive tests
7. Submit PR with security checklist

## 🛡️ Security Policy

Found a security vulnerability? Please **DO NOT** open a public issue.

Email: <security@aegis.dev> (PGP key available)

See [SECURITY.md](SECURITY.md) for our responsible disclosure policy.

## 📊 Tool Compatibility Matrix

| Tool | MCP Version | AEGIS Version | Python | TypeScript | Rust |
| ------ | ------------ | --------------- | -------- | ------------ | ------ |
| filesystem | 1.0 | ≥0.1.0 | ✅ | ✅ | ✅ |
| web-search | 1.0 | ≥0.1.0 | ✅ | ✅ | ✅ |
| browser | 1.0 | ≥0.2.0 | ✅ | ✅ | ⚠️ |
| database | 1.0 | ≥0.1.0 | ✅ | ✅ | ✅ |
| gmail | 1.0 | ≥0.1.0 | ✅ | ✅ | ❌ |
| github | 1.0 | ≥0.1.0 | ✅ | ✅ | ⚠️ |
| slack | 1.0 | ≥0.1.0 | ✅ | ✅ | ❌ |

## 📜 License

Business Source License 1.1 - See [LICENSE](LICENSE) for details.

## 🔗 Links

- **Main Repository**: [github.com/aent-ai/aegis-orchestrator](https://github.com/aent-ai/aegis-orchestrator)
- **Documentation**: [docs.aegis.dev](https://docs.aegis.dev)
- **MCP Specification**: [modelcontextprotocol.io](https://modelcontextprotocol.io)
- **Security Policy**: [SECURITY.md](SECURITY.md)

---

**AEGIS MCP Tools** - Secure tool execution for autonomous agents
