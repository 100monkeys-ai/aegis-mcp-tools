# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

## Security Philosophy

AEGIS MCP Tools is designed to address the "Supply Chain Risk" identified in OpenClaw deployments. Every tool in this repository undergoes rigorous security review.

## Security Principles

1. **Fail-Safe Defaults**: All permissions denied unless explicitly granted
2. **Least Privilege**: Tools request minimum necessary permissions
3. **Defense in Depth**: Multiple layers of security controls
4. **Audit Everything**: Immutable logging of all operations
5. **Assume Breach**: Design for containment and recovery

## Threat Model

### Trust Boundaries

```
┌─────────────────────────────────────────┐
│         AEGIS Orchestrator              │
│         (Trusted Runtime)               │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│         MCP Tool (This Repository)      │
│         (Sandboxed Execution)           │
│  • Input validation                     │
│  • Resource limits                      │
│  • Permission enforcement               │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│     External Services / Filesystem      │
│     (Untrusted)                         │
└─────────────────────────────────────────┘
```

### Threat Scenarios

1. **Malicious Input**: Agent sends crafted input to exploit tool
2. **Resource Exhaustion**: Tool consumes excessive CPU/memory
3. **Data Exfiltration**: Tool attempts to access unauthorized data
4. **Privilege Escalation**: Tool bypasses permission boundaries
5. **Supply Chain Attack**: Malicious dependency introduced

## Security Controls

### 1. Input Validation

All tools must validate inputs:

```python
from aegis_mcp_tools.validators import validate_path, validate_url

def read_file(path: str):
    # Validate and sanitize
    safe_path = validate_path(path, allowed_dirs=["/data"])
    
    # Enforce chroot
    if not safe_path.startswith("/data"):
        raise SecurityError("Path outside allowed directory")
    
    # Check file size
    if os.path.getsize(safe_path) > MAX_FILE_SIZE:
        raise SecurityError("File too large")
```

### 2. Resource Limits

Every tool has hard limits:

```yaml
resources:
  max_memory: "256MB"     # Hard limit
  max_cpu: "0.5"          # CPU shares
  timeout: "30s"          # Max execution time
  max_network: "10MB/s"   # Bandwidth cap
```

### 3. Permission Enforcement

Network and filesystem access controlled:

```yaml
permissions:
  filesystem:
    read: ["/data/inputs"]
    write: ["/data/outputs"]
    deny: ["/etc", "/root", "/home"]
  network:
    allow: ["api.example.com"]
    deny: ["*"]
```

### 4. Audit Logging

All operations logged immutably:

```python
@audit_log
def execute(self, params):
    # Automatically logs:
    # - Timestamp
    # - Tool name
    # - Parameters (sanitized)
    # - Result summary
    # - Resource usage
    pass
```

### 5. Secrets Management

Never log or expose secrets:

```python
# ✅ Correct
api_key = os.environ.get("API_KEY")
logger.info("Making API call", url=url)  # Don't log key

# ❌ Wrong
logger.info(f"Using key: {api_key}")
```

## Reporting a Vulnerability

**DO NOT** open a public issue for security vulnerabilities.

### Reporting Process

1. **Email**: security@aegis.dev (PGP key below)
2. **Subject**: `[SECURITY] Brief description`
3. **Include**:
   - Tool name and version
   - Description of vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

### Response Timeline

- **24 hours**: Acknowledgment of report
- **72 hours**: Initial assessment
- **7 days**: Patch development
- **14 days**: Public disclosure (coordinated)

### Disclosure Policy

We follow **coordinated disclosure**:

1. Vulnerability reported privately
2. Patch developed and tested
3. Security advisory published
4. Public disclosure with credit

## Security Champions

Current security reviewers:

- @security-team (Primary contact)

## PGP Key

```
-----BEGIN PGP PUBLIC KEY BLOCK-----
[PGP key for security@aegis.dev]
-----END PGP PUBLIC KEY BLOCK-----
```

## Bug Bounty Program

We recognize and reward security researchers:

- **Critical**: $1,000 - $5,000
- **High**: $500 - $1,000
- **Medium**: $100 - $500
- **Low**: Recognition in SECURITY.md

### In-Scope

- Remote code execution
- Privilege escalation
- Data exfiltration
- Authentication bypass
- Resource exhaustion

### Out-of-Scope

- Social engineering
- Physical attacks
- DoS requiring >10K requests/second
- Issues in dependencies (report upstream)

## Security Hardening Checklist

For contributors adding new tools:

### Input Handling
- [ ] All inputs validated with strict schemas
- [ ] Path traversal prevented
- [ ] SQL injection prevented (if applicable)
- [ ] Command injection prevented
- [ ] XXE attacks prevented (XML parsing)

### Network Security
- [ ] TLS/SSL required for all connections
- [ ] Certificate validation enforced
- [ ] Allowlist configured (no wildcards)
- [ ] Timeouts configured
- [ ] Rate limiting implemented

### Filesystem Security
- [ ] Chroot jail or equivalent
- [ ] Symlink attacks prevented
- [ ] File size limits enforced
- [ ] Sensitive paths blacklisted

### Resource Management
- [ ] Memory limits enforced
- [ ] CPU limits enforced
- [ ] Execution timeout configured
- [ ] Connection pooling with limits

### Error Handling
- [ ] Errors don't leak paths
- [ ] Errors don't leak credentials
- [ ] Stack traces sanitized
- [ ] Generic error messages to users

### Logging
- [ ] All operations logged
- [ ] Secrets redacted
- [ ] Structured logging used
- [ ] Log injection prevented

## Security Updates

Subscribe to security advisories:

- **GitHub**: Watch this repo for security alerts
- **Email**: Subscribe at security@aegis.dev
- **RSS**: https://github.com/100monkeys-ai/aegis-mcp-tools/security/advisories

## Compliance

This project follows:

- **OWASP Top 10** mitigation strategies
- **CWE Top 25** prevention guidelines
- **NIST Cybersecurity Framework** principles

## Acknowledgments

We thank the following researchers for responsible disclosure:

- [Coming soon - report vulnerabilities to be listed here]

---

**Last Updated**: 2026-02-01
**Next Review**: 2026-05-01
