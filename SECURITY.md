# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Agorax, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, report via [GitHub Security Advisories](https://github.com/jingr1/agorax/security/advisories) or DM [@ericousodev on X](https://x.com/ericousodev).

We will acknowledge your report within 48 hours and aim to provide a fix within 7 days for critical issues.

## Scope

- Agorax web application code
- API routes and agent runtime communication
- Authentication and session management
- Client-side data handling and rendering
- Exec approval and human-in-the-loop controls
- Browser proxy and screenshot endpoints

## Out of Scope

- Hermes Agent itself (report to the Hermes Agent project)
- Third-party dependencies (report to the respective maintainer)
- Social engineering attacks

## Security Measures

**Authentication**

- All API routes require authentication
- Session tokens use timing-safe comparison to prevent timing attacks
- httpOnly + SameSite=Strict cookies
- Token revocation on logout

**Network**

- `Access-Control-Allow-Origin` restricted to localhost — no wildcard CORS
- Browser proxy and screenshot endpoints locked to same-origin only
- Rate limiting on high-risk endpoints (file access, debug, exec)

**Data & File Access**

- Path traversal prevention on all file and memory routes (`ensureWorkspacePath()`)
- `.md`-only restriction on memory write routes
- No API keys or secrets ever exposed to client-side code
- Gateway / provider tokens are server-side only
- Diagnostic output scrubbed of sensitive data

**Agent Safety**

- Exec approval workflow — sensitive agent exec commands require explicit human approval via in-UI modal
- Skills security scanning — every skill from the marketplace is scanned for suspicious patterns before install

**Configuration**

- Environment files are gitignored
- Config endpoints redact credentials in responses
- Example configs use placeholder keys only

## Security Audit Passes

No formal third-party security audits have been performed yet. This section will be updated when audits are completed.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| main    | ✅ Active |
