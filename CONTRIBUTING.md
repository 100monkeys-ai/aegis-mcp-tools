# Contributing to AEGIS MCP Tools

Thank you for your interest in contributing to AEGIS MCP Tools! This repository maintains security-critical components, so we have strict review processes.

## Before You Start

1. **Read the Security Policy**: All tools must pass security review - see [SECURITY.md](SECURITY.md)
2. **Check Existing Tools**: Ensure your tool doesn't duplicate existing functionality
3. **Open an Issue**: Discuss your proposed tool before implementation

## Development Workflow

### 1. Fork and Clone

```bash
git clone https://github.com/YOUR_USERNAME/aegis-mcp-tools.git
cd aegis-mcp-tools
```

### 2. Create a Feature Branch

```bash
git checkout -b tool/my-new-tool
```

### 3. Implement Your Tool

```markdown
tools/my-tool/
├── schema.json          # MCP schema definition
├── server.py            # Implementation (Python or TypeScript)
├── security.yaml        # Security manifest
├── README.md            # Tool documentation
└── tests/
    └── test_my_tool.py  # Comprehensive tests
```

### 4. Security Manifest (Required)

Every tool must include a `security.yaml`:

```yaml
tool: my-tool
version: "1.0.0"
description: "Brief description"

security:
  permissions:
    filesystem:
      read: []
      write: []
    network:
      allow: []
      deny: ["*"]
  resources:
    max_memory: "128MB"
    max_cpu: "0.5"
    timeout: "30s"
  audit:
    log_all_calls: true
    include_args: true
```

### 5. Write Tests

Minimum 80% code coverage required:

```python
# tests/test_my_tool.py
import pytest
from aegis_mcp_tools.my_tool import MyTool

def test_basic_functionality():
    tool = MyTool()
    result = tool.execute({"input": "test"})
    assert result["success"] is True

def test_security_violation():
    tool = MyTool()
    with pytest.raises(SecurityError):
        tool.execute({"path": "/etc/passwd"})
```

### 6. Run Security Checks

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run linters
make lint

# Run security scanner
make security-scan

# Run tests
make test
```

### 7. Submit Pull Request

Include in your PR description:

- [ ] What does this tool do?
- [ ] Why is it needed?
- [ ] What are the security implications?
- [ ] How was it tested?
- [ ] Security review checklist completed

## Security Review Checklist

Before submitting, ensure:

- [ ] **Input Validation**: All user inputs are validated and sanitized
- [ ] **Resource Limits**: Memory, CPU, and timeout limits defined
- [ ] **Network Policy**: Explicit allowlist, no wildcards unless justified
- [ ] **Filesystem Access**: Minimal paths, no access to sensitive directories
- [ ] **Error Handling**: Errors don't leak sensitive information
- [ ] **Audit Logging**: All operations logged with context
- [ ] **Rate Limiting**: Prevents abuse
- [ ] **Tests**: Security-focused tests included
- [ ] **Documentation**: Threat model documented

## Code Style

### Python

- Follow PEP 8
- Use type hints
- Maximum line length: 100 characters
- Use `black` for formatting

### TypeScript

- Follow Airbnb style guide
- Strict TypeScript (`strict: true`)
- Use Prettier for formatting

### Documentation

- All public functions must have docstrings
- Include usage examples
- Document security considerations

## Tool Categories

### Core Tools

System-level tools (filesystem, shell, http)

- Require 2+ maintainer approvals
- Extensive security review

### Integration Tools

Third-party API integrations (Gmail, Slack, GitHub)

- Require OAuth2/API key handling review
- Rate limiting mandatory

### Utility Tools

Helper functions and wrappers

- Standard review process

## Release Process

1. Maintainers tag releases
2. Semantic versioning (MAJOR.MINOR.PATCH)
3. Changelog updated
4. Security audit before major releases

## Getting Help

- **Discord**: [discord.gg/aegis](https://discord.gg/aegis)
- **Discussions**: Use GitHub Discussions
- **Email**: <community@100monkeys.ai>

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

Thank you for helping make AEGIS MCP Tools secure and reliable! 🛡️
