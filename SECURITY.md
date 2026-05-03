# Security policy

We take security seriously — Caelo runs untrusted plugin code, accepts public writes, and routinely manages credentials for hosting providers + AI providers. A vulnerability in any of those surfaces affects every Caelo install.

## Reporting a vulnerability

**Do NOT open a public GitHub issue for a security vulnerability.**

Use **[GitHub's Private Vulnerability Reporting](https://github.com/caelo-cms/caelo-cms/security/advisories/new)** on this repository. The form lands directly in the maintainers' inbox; nothing is public until we publish the fix.

If you can't use the GitHub form (no GitHub account, etc.), email **security@caelo-cms.com** with:

- A description of the vulnerability + the affected component
- Steps to reproduce against a fresh `bunx cms-provision --provider self-hosted` install
- Any proof-of-concept code (private gist link is fine)
- Your preferred disclosure timeline (default: 90 days from acknowledgement)
- Whether you'd like credit in the fix's release notes

We acknowledge reports within **72 hours** and aim to ship a fix within **90 days** for high-severity issues, **30 days** for critical ones. We coordinate disclosure timing with the reporter.

## Scope

In scope:

- The admin app (`apps/admin`) and its API surface
- The Query API + Database Adapter (`packages/query-api`)
- The plugin host + sandbox (`packages/plugin-host`, `packages/plugin-sandbox`)
- Any of the five core Tier 1 plugins (forms, comments, newsletter, ratings, auth) when run as shipped
- The provisioning surface (`packages/provisioning`) — secret handling, IAM scope, network isolation
- The MCP server (`packages/mcp-server`)
- The static-generator output (`apps/static-generator`)
- The API gateway (`apps/api-gateway`)

Out of scope (please report upstream):

- Vulnerabilities in third-party dependencies — file with the upstream project; we'll bump the version once they fix
- Issues that require physical access to the host or shell access to the database
- Issues that depend on already-compromised credentials (e.g. "if I have your `ANTHROPIC_API_KEY`, I can…")
- Self-XSS in the Owner's own browser context (Owner is trusted — they can paste raw HTML into a module if they choose)
- DoS via expensive AI prompts (use the per-token + per-budget caps surfaced at `/security/ai/budgets`)

## What we promise reporters

- **Acknowledgement within 72 hours** — even if the fix takes longer.
- **Public credit** in the security advisory when the fix ships, unless you prefer to remain anonymous.
- **A coordinated disclosure timeline** — we won't publish before you're ready, and we won't sit on the fix indefinitely either.
- **No legal action** for good-faith research that follows this policy. Don't access data beyond what's needed to demonstrate the issue.

## Operating Caelo in production

The incident response runbook for operators (rotation flow when a secret leaks, audit-trail forensics, postmortem template) lives in **[`docs/incident-response.md`](./docs/incident-response.md)**. Read §G for the secret-leak playbook before you need it.

## Cryptographic surfaces

Caelo uses cryptographic primitives in three places. Issues with any of them are critical-severity:

- **Tier 1 plugin manifest signatures** — Ed25519 over the manifest JSON. Public key embedded in the host build; rotated on major version bumps.
- **Internal-API tokens + cookie/CSRF/HMAC secrets** — minted at install via `cms-provision`; stored in the platform's secrets manager.
- **MCP token bearer hashes** — sha256 at rest; the plaintext bearer is shown ONCE at mint time.

Implementation lives in `packages/plugin-sandbox/src/manifest.ts`, `apps/admin/src/lib/server/csrf.ts`, and `packages/admin-core/src/ops/security/mcp_tokens.ts` respectively.
