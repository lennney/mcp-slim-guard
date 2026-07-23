# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.x     | ✅        |

## Reporting a Vulnerability

mcp-slim-guard is a security tool — the safety of our users is our top priority.

If you discover a security vulnerability, please **do NOT** file a public GitHub issue. Instead, send a description to:

**GitHub Issues**: [github.com/lennney/mcp-slim-guard/issues](https://github.com/lennney/mcp-slim-guard/issues)  
(use the "Security" label, or email the maintainer directly)

We will:

1. Acknowledge receipt within 48 hours
2. Investigate and provide a timeline for a fix
3. Publish a security advisory once the fix is released

## Scope

mcp-slim-guard is a security proxy that enforces policies between AI agents and MCP servers. The following are in scope for security reports:

- Bypass of policy enforcement (allow/deny, SSRF, injection detection, rate limiting)
- Audit log tampering or bypass
- Remote code execution through crafted tool arguments
- Information disclosure through error messages or logging
- Authentication/authorization bypass in HTTP transport mode

## Out of Scope

- Vulnerabilities in upstream MCP servers (these are the user's responsibility to secure)
- Social engineering of project maintainers
- Attacks requiring physical access to the machine running mcp-slim-guard

## Recognition

We maintain a list of security researchers who have helped improve mcp-slim-guard's security in our [CHANGELOG](./CHANGELOG.md).
