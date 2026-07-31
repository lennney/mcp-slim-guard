# Security Policy

## Supported versions

| Version                  | Support     |
| ------------------------ | ----------- |
| Latest published release | Supported   |
| Older prereleases        | Best effort |

## Report a vulnerability

Do not disclose a vulnerability, exploit, credential, private path, or result
body in a public issue.

Use GitHub to
[privately report a security vulnerability](https://github.com/lennney/mcp-slim-guard/security/advisories/new).
Include the affected version, impact, reproduction steps, and a minimal
proof of concept. Remove unrelated credentials, private paths, and result
contents before submission.

## In scope

Security reports can include:

- bypassing Tool authorization, discovery filtering, or call policy;
- binding a call to the wrong upstream Server or Tool;
- causing one Slim Guard call to execute upstream more than once;
- reading another runtime generation's result snapshot;
- recovering a result that differs from the stored upstream result;
- exposing credentials, arguments, result bodies, or raw capability references
  through logs or errors;
- bypassing SSRF or parameter restrictions in a configured transport;
- executing code through crafted configuration, Tool metadata, arguments, or
  results.

## Out of scope

- vulnerabilities that exist only in an upstream MCP Server;
- social engineering;
- attacks that require physical access to the Slim Guard host;
- benchmark differences that do not cross a security or data boundary.

When a report is confirmed, the maintainer will coordinate remediation and
public disclosure with the reporter. Response and release timing depend on the
impact and available evidence.

## Recognition

With the reporter's consent, confirmed contributions can be recognized in the
release notes or `CHANGELOG.md`.
