---
slug: security
template: doc-page
locale: en
status: published
seo:
  title: Security policy — Caelo CMS
  description: Disclosure flow via GitHub Private Vulnerability Reporting. 72-hour acknowledgement, 90-day disclosure target. Scope, out-of-scope, cryptographic surfaces.
---

# Security policy

This is the public version of [`SECURITY.md`](https://github.com/caelo-cms/caelo-cms/blob/main/SECURITY.md) in the source repo. Same content, lightly rewritten for visitors.

## Reporting a vulnerability

**Do NOT open a public GitHub issue for a security vulnerability.**

Use [GitHub Private Vulnerability Reporting](https://github.com/caelo-cms/caelo-cms/security/advisories/new) on the canonical repo. The form lands directly in the maintainers' inbox; nothing is public until we publish the fix.

If you can't use the GitHub form (no GitHub account, etc.), email **security@caelo-cms.com** with:

- A description of the vulnerability + the affected component
- Steps to reproduce against a fresh `bunx @caelo/provisioning --provider self-hosted` install
- Any proof-of-concept code (private gist link is fine)
- Your preferred disclosure timeline (default: 90 days from acknowledgement)
- Whether you'd like credit in the fix's release notes

We acknowledge reports within **72 hours** and aim to ship a fix within **90 days** for high-severity issues, **30 days** for critical ones. We coordinate disclosure timing with you.

## Scope

In scope:

- The admin app + its API surface
- The Query API + Database Adapter
- The plugin host + sandbox (oxc-parser validator + Deno subprocess + RLS scoping)
- Any of the five core Tier 1 plugins (forms, comments, newsletter, ratings, auth) when run as shipped
- The provisioning surface — secret handling, IAM scope, network isolation
- The MCP server (`@caelo/mcp-server`)
- The static-generator output
- The API gateway

Out of scope (please report upstream):

- Vulnerabilities in third-party dependencies — file with the upstream project; we'll bump the version once they fix
- Issues that require physical access to the host or shell access to the database
- Issues that depend on already-compromised credentials ("if I have your `ANTHROPIC_API_KEY`, I can…")
- Self-XSS in the Owner's own browser context — the Owner is trusted; raw HTML in modules is by design
- DoS via expensive AI prompts — use the per-token + per-budget caps at `/security/ai/budgets`

## What we promise reporters

- **Acknowledgement within 72 hours** — even if the fix takes longer
- **Public credit** in the security advisory when the fix ships, unless you prefer anonymity
- **Coordinated disclosure** — we won't publish before you're ready, and we won't sit on the fix indefinitely
- **No legal action** for good-faith research that follows this policy. Don't access data beyond what's needed to demonstrate the issue.

## Cryptographic surfaces

Three places. Issues with any of them are critical-severity:

- **Tier 1 plugin manifest signatures** — Ed25519 over the manifest JSON. Public key embedded in the host build; rotated on major version bumps.
- **Internal API tokens + cookie/CSRF/HMAC secrets** — minted at install via `bunx @caelo/provisioning`; stored in the platform's secrets manager.
- **MCP token bearer hashes** — sha256 at rest; the plaintext bearer is shown ONCE at mint time on `/security/mcp`.

Implementation: `packages/plugin-sandbox/src/manifest.ts`, `apps/admin/src/lib/server/csrf.ts`, `packages/admin-core/src/ops/security/mcp_tokens.ts`.

## For operators

The incident-response runbook is in [`docs/incident-response.md`](https://github.com/caelo-cms/caelo-cms/blob/main/docs/incident-response.md). Read **§G secret-leak playbook** before you need it. The 5-step rotation flow:

1. Rotate at the source FIRST (provider key / OAuth secret / DB password / etc.)
2. Audit access during the leak window via `/security/audit/[requestId]`
3. Scrub from git history if committed (use `git-filter-repo`, not the deprecated `filter-branch`)
4. Document in postmortem (template at the bottom of `incident-response.md`)
5. Add a detection rule (e.g. `gitleaks` pre-commit hook)

## Code of conduct

Project-wide: [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Report Code of Conduct violations to **conduct@caelo-cms.com**.
