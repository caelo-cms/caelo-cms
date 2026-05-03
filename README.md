# Caelo CMS

**AI-first, open-source CMS.** Built for the AI agent as the primary user — humans configure, AI authors. Self-hostable on a single VM or one-click deploy to GCP / AWS / Azure. MPL 2.0.

[![CI](https://github.com/caelo-cms/caelo-cms/actions/workflows/ci.yml/badge.svg)](https://github.com/caelo-cms/caelo-cms/actions/workflows/ci.yml)
[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](./LICENSE)
[![Docs](https://img.shields.io/badge/docs-caelo--cms.com-blue)](https://caelo-cms.com)

---

## What it does

You talk to your site. The AI agent edits modules, drafts pages, translates copy, moderates comments, proposes layout changes — every action lands as a draft snapshot, you review, you publish. The architecture is layered so the AI can't ship a page without your click; the chat surface drives every routine task; the live-edit overlay shows your real site while you work.

```
talk → preview → publish.
```

Behind that loop sits a small, opinionated kernel: two isolated Postgres roles with RLS forced on every table, a Query API chokepoint that gates every write, a snapshot system where every change is reverted by clicking back through chat history, a plugin host that runs core code in-process and sandboxes everything else in Deno, and provisioning that hands you SSL + cron + DB backups on the first run.

## Install in one line

```bash
bunx @caelo/provisioning --provider self-hosted
```

That stands up Postgres + pgBackRest + Caddy (with auto-SSL) + the admin app + the API gateway as a Docker Compose stack. It works on any Linux box with Docker + Bun.

For cloud:

```bash
bunx @caelo/provisioning --provider gcp     # or aws, or azure
```

Cloud paths use Pulumi to spin up Cloud SQL HA + managed object storage + the platform's CDN + Secret Manager + Cloud Run / Lambda / Container Apps. You get staging + production as separate stacks; staging is `noindex` by default.

Talk to your install from your IDE (Claude Code, etc.) without opening the browser:

```bash
claude mcp add caelo --command "bunx @caelo/mcp-server" \
  --env CAELO_ADMIN_URL=https://your-install.example.com \
  --env CAELO_MCP_TOKEN=$(your minted bearer)
```

Mint the bearer at `/security/mcp` on your install.

## Documentation

The docs site at **[caelo-cms.com](https://caelo-cms.com)** is itself a Caelo install. Quickstart per provider, architecture overview, plugin authoring, security policy, changelog — all there.

For contributors: read **[`CONTRIBUTING.md`](./CONTRIBUTING.md)** and **[`CLAUDE.md`](./CLAUDE.md)** before opening a PR. The architecture overview lives in **[`ARCHITECTURE.md`](./ARCHITECTURE.md)**, and the canonical product spec is **[`CMS_REQUIREMENTS.md`](./CMS_REQUIREMENTS.md)**.

## What's in the box

- **Pages, modules, templates, layouts** — composed by reference, never by raw HTML on a page.
- **Two-database split** — `cms_admin` (authoring) + `cms_public` (visitor + plugin data) with RLS forced on every table.
- **Live-edit overlay** — your real site in a chrome-less iframe + a floating chat overlay; click any element, ask the AI, watch it change in place.
- **Snapshot versioning + chat-keyed Undo** — every write emits a snapshot; every revert is one click.
- **Multi-locale + URL strategies** — subdirectory / subdomain / separate domain, mixed within one site.
- **AI translation** (Mode 1 + Mode 2) with per-locale glossary + style guide.
- **Skills system** — Claude-style skill bodies the AI engages per turn, Owner-curated, AI-proposable.
- **Subagents** — the AI spawns parallel reasoning loops (QA, brand-voice, legal-check) on demand.
- **Two-tier plugin host** — Tier 1 plugins ship with core (signed, in-process, full SDK); Tier 2 plugins are AI-authored at runtime + sandboxed in Deno (locked SDK, only their own `cms_public` schema).
- **Five core plugins** — forms, comments, newsletter, ratings, visitor auth (email/password + OAuth via Arctic).
- **API gateway** with rate-limiting + CAPTCHA / PoW + honeypot + debounced auto-redeploy.
- **A/B experiments at the edge** — stable per-visitor hash + analytics-plugin attribution.
- **Multi-provider AI** — Anthropic / OpenAI / Google / local OpenAI-compat behind a provider abstraction; per-(scope × operation_type) budgets enforced independently.
- **Pulumi provisioning** — self-hosted + GCP + AWS + Azure adapters; one-line bootstrap to TLS-served staging + production.
- **MCP server** — drive your install from any MCP-aware client; same agent the live-edit chat uses.

## Status

**Pre-1.0 (v0.1.0).** The product surface is complete; the OSS launch is the dogfooding pass. Expect rough edges in the first 30 days; we fix in real-time and ship paper-cut releases.

The pre-1.0 invariant from `CLAUDE.md` §2: every code path that could "default to something sensible when data is missing" instead **fails loudly with a structured error**. That rule is relaxed deliberately at 1.0.0 with a documented breaking-change policy.

## Local development

Prerequisites: [Bun](https://bun.sh/) ≥ 1.3, Docker + Docker Compose, [Deno](https://deno.com) ≥ 2 (for the Tier 2 plugin sandbox), an Anthropic API key.

```bash
git clone https://github.com/caelo-cms/caelo-cms.git
cd caelo-cms
cp .env.example .env                  # then add ANTHROPIC_API_KEY
bun install
docker compose up -d                  # postgres + caddy
bun run db:migrate                    # both cms_admin + cms_public migrations
bun run --filter @caelo/admin seed:dev
bun run --filter @caelo/admin dev     # admin at http://localhost:5173
```

Verify before opening a PR:

```bash
bun run lint            # biome + audit-callsites + SPDX
bun run typecheck       # tsc -b across the whole workspace
bun test                # unit + integration; needs Postgres up
bun run license:check   # transitive license allowlist
```

## License

[MPL 2.0](./LICENSE). Maximum freedom for developers and hosting providers; modifications to core files stay open; one license, no dual-licensing.

All dependencies are MPL-2.0-compatible (MPL-2.0, Apache-2.0, MIT, BSD, ISC). `bun run license:check` enforces this in CI.

## Security

Report vulnerabilities via **[GitHub Private Vulnerability Reporting](https://github.com/caelo-cms/caelo-cms/security/advisories/new)**. Full policy in **[`SECURITY.md`](./SECURITY.md)**.

## Contributing

See **[`CONTRIBUTING.md`](./CONTRIBUTING.md)**. Code of Conduct: the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
