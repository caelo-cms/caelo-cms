# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0 releases follow the **no-fallbacks invariant** documented in `CLAUDE.md` §2 — code paths fail loudly with structured errors when expected data is missing rather than silently substituting defaults. This rule is relaxed deliberately at 1.0.0.

## [Unreleased]

### Added
- P17 PR4 — `caelo_chat` MCP server (`packages/mcp-server`). Single-tool MCP server lets Claude Code (or any MCP-aware client) drive a Caelo install from outside the browser. Owner UI at `/security/mcp` mints + revokes bearer tokens; the bridge dispatches every call into the existing chat-runner with the resolved Owner identity. Per-token AI cost cap enforced via P10.5's `costCapMicrocents` surface.
- P17 PR1 — project hygiene for OSS launch: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, this `CHANGELOG.md`, `.github/PULL_REQUEST_TEMPLATE.md`, three issue templates, SPDX-header lint wired into root `lint`, version bump to 0.1.0 across every workspace.

## [0.1.0] — first OSS release

### P0 — Repo bootstrap
Bun monorepo (`apps/admin`, `apps/static-generator`, `apps/api-gateway`, `packages/*`), TypeScript strict, Biome, Zod, Postgres via Docker Compose, GitHub Actions CI (lint + typecheck + test + license-check), `CLAUDE.md` engineering principles. Bun-native test runner.

### P1 — Database + Query API foundation
Two databases (`cms_admin`, `cms_public`) with two isolated PostgreSQL roles, RLS `FORCE`d on every table both ways, Query API → Validator → Database Adapter → Postgres chain. Undefined operations fail closed; cross-database / cross-actor / cross-plugin reads fail closed. `RateLimiter` interface plumbed through the executor. CI runs `bootstrap.sh` directly + integration tests against the production-shape `public_role`.

### P2 — Admin shell + auth + security control panel
SvelteKit + `svelte-adapter-bun` admin app. Session-based email/password login; built-in Owner / Editor / Reviewer roles + Owner-defined custom roles enforced via a fixed permission catalog. CSRF double-submit at the form layer. Login rate-limit (5 / 5 min per IP). System actor seed for pre-auth audit FK. Setup-race hardening via Postgres advisory lock. Security control panel scaffold.

### P3 — Module / Template / Page content model
Three content primitives via Query API only: `modules` (HTML+CSS+JS, live-referenced), `templates` (named blocks), `pages` (ordered list of module references — no raw HTML field, enforced at the Validator). Admin CRUD + preview composition.

### P4 — Snapshot versioning + revert
Every Query API write emits a snapshot. Chat-keyed Undo/Redo as the primary surface; per-module + per-site revert in the Advanced History drawer. Module A/B variants land as sibling `module_snapshots` tagged with `experiment_id` — no new versioning concept.

### P5 — AI provider abstraction + first AI module edit
Provider Abstraction Layer (Anthropic Claude Opus 4.7 first), token accounting, admin AI chat UI. Site-AI-memory store (Owner-curated brand voice / tone / banned phrases) prepended to every AI call. Chat sessions + ephemeral chat-branches + click-to-chat element references + visual content diff overlay.

### P6 — Static generator + local deploy (MVP complete)
Astro-based static generator reads `cms_admin` via the Query API and emits `dist/` of plain HTML/CSS/JS. Three-environment model (dev / staging / production); editors see Draft → Live, Ops users see the full pipeline. Reserves hooks for A/B variant emission consumed at the edge.

### P6.5 — Admin UI framework
Tailwind CSS 4 + shadcn-svelte. AppShell with persistent sidebar nav, breadcrumbs, top bar. Dark mode + design-token theming. shadcn primitives copied into `apps/admin/src/lib/components/ui/` — owned outright, no runtime dep.

### P6.7 — Live-edit overlay (the flagship UX)
Editor lands on `/edit` → rendered website in an iframe + floating draggable chat overlay. Click-to-chat references the actual element; chips accumulate so multi-element edits run in one AI turn. Branch-aware preview via `pages.render_preview(chatBranchId=...)`. Stage + Confirm-publish strip in the toolbar.

### P6.6 — Admin UX polish
Skeleton loaders, empty-state component upgrades, inline Zod validation on high-traffic forms, microcopy sweep, brand assets, `prefers-reduced-motion` + `forced-colors` honoured everywhere, axe-core AA gating in CI. Deploy-progress polling, drag-and-drop module reordering, side-by-side iframe diff, Cmd-K command palette, keyboard shortcuts, first-login onboarding tour, notification bell.

### P7 — Media library
Object-storage abstraction (local volume adapter for self-hosted), upload endpoint with MIME / size validation, sharp-driven optimisation pipeline (resize variants + WebP), media browser. AI references media by URL via Query API; never touches storage directly. Optional CDN copy at deploy for frequently-used assets.

### P8 — SEO + Redirects + sitemap / robots
Per-page structured SEO fields (no raw `<head>` HTML). Fill-once via `seo-autofill`; explicit cross-page `seo-optimize` for re-runs. Redirect manager + admin UI. `sitemap.xml`, `robots.txt`, provider-specific redirect file generators.

### P9 — i18n foundation + locale URL strategies
Per-locale `(slug, locale)` page rows + `content_hash` / `translated_from_hash` / `translation_status` fields. Locale config table supports per-locale URL strategy (subdirectory default, subdomain, separate domain). Admin-only — every locale-config Query API op rejects AI actors. Auto hreflang generation. Built-in language selector module.

### P10 — AI translation (Mode 1 + Mode 2) + dashboard
Block-level structured diff. Glossary + style guide. Translation dashboard with single-action "Bring up to date" per row + top-level "Auto-translate everything stale" bulk action. Mode 1 = new locale variant from source; Mode 2 = update existing translation with the structured diff. All translations land as drafts; user confirms via the standard publish flow.

### P10A — Skills system + auto-engagement + base skills
Claude-style skills in `cms_admin.skills`. Two-level activation: site-wide (Owner-required) and per-chat engagement (auto-matcher + manual override). Per-chat Engaged Skills panel, manual engage/disengage persists for chat life, pinned defaults per user. Base skills shipped: `compose-page`, `explain-page`, `brand-voice-guard`, `translation-mode-1`/`-mode-2`, `seo-autofill`, `seo-optimize`, `summarize-plugin-data`, `scoped-edit`, `import-site`, `site-memory-learner`.

### P10.5 — Subagents (AI spawns AI for parallel reasoning)
`spawn_subagent` + `spawn_subagents` AI tools. Each subagent runs its own `runChatTurn` invocation (same chat-runner, no special runtime) with parent attribution + cost cap + timeout. Depth cap of 1, read-only by default, no-publish defence by actor scope. `subagent_runs` table for observability.

### P11 — Two-tier plugin host
`@caelo/plugin-sdk` + `@caelo/plugin-sandbox` (oxc-parser validator + Ed25519 manifest verifier + Deno subprocess wrapper) + `@caelo/plugin-host` (Tier 1 in-process loader + capability factory). Tier 1 = core plugins, signed, in-process, full SDK; Tier 2 = AI-authored / Owner-installed at runtime, Deno-sandboxed, locked SDK (only `cms_public.<slug>` schema, no AI provider, no chat-runner tool registration). Activation: Tier 1 auto on signature verify; Tier 2 Owner-click per `active` transition.

### P11.5 — Translation port + plugin-host runtime
Plugin host bootstrap + capability runtime (cms / ai / snapshots / tools / workers). Croner-backed worker scheduler. Dynamic AI-tool registry. Translation ops moved to a Tier 1 plugin (`packages/plugins/translation/`) as the SDK proof-of-concept.

### P12 — Five core Tier 1 plugins + minimal API gateway
`packages/plugins/{forms,comments,newsletter,ratings,auth}`, each ~3-4 hr of mechanical SDK work. `apps/api-gateway/` Bun HTTP server routing public POSTs to `plugins.run_operation`. New SDK handles: `ctx.query` (real cms_public dispatch), `ctx.api`, `ctx.email`, `ctx.visitor`, `ctx.captcha`. Owner UIs per plugin under `/security/plugins/<slug>`.

### P12A — Extended built-ins
Scheduled publish, component kits, typed content, edge-log analytics + A/B experiments dashboard. All Tier 1 plugins.

### P13 — Static + delta + auto-redeploy + gateway hardening + A/B edge split
Static generator bakes approved plugin data; Web Components fetch deltas via `since=<deploy-timestamp>`. Gateway: per-(plugin, op, visitor) rate limiting, CAPTCHA / PoW on public writes, honeypot fields, 10-15s debounced auto-redeploy. Stable-hash A/B edge router selects per-visitor variants and emits assignment logs into the analytics plugin.

### P14 — Pulumi self-hosted provisioning + Site Import Wizard
`bunx cms-provision --provider self-hosted` stands up Docker Compose with Postgres + pgBackRest + Caddy (Let's Encrypt) + MinIO + the CMS services. Three-environment stacks. Site Import Wizard: scrape an existing URL, draft modules + content, screenshot-diff per page, Owner reviews + publishes to staging.

### P15 — Cloud provisioning adapters (GCP, AWS, Azure)
Provider-specific Pulumi adapters: GCP (Cloud SQL HA + Cloud Storage + CDN + Cloud Run + Secret Manager), AWS (RDS Multi-AZ + S3 + CloudFront + Lambda + Secrets Manager), Azure (Azure DB + Blob + Front Door + API Management + Key Vault). Per-provider redirect file generators + edge A/B split rules.

### P16 — Multi-provider AI + cost dashboard + telemetry
Anthropic / OpenAI / Google / local-OpenAI-compat adapters behind the P5 abstraction. Operation-type budgets (text + image enforce independently). Owner-editable `ai_pricing` table — rate changes flow without redeploy via in-process LRU + `pg_notify` invalidation. `/security/costs` five-panel dashboard. Per-plugin cost cap with fail-closed enforcement after sustained lookup failures. `request_id` propagated through every audit row + AI call; `/security/audit/[requestId]` correlation view. Opt-in telemetry with payload preview before transmission.

### P16 hardening
Fail-closed cap-lookup tracking (`packages/shared/src/cap-failures.ts`), pricing LRU + invalidation, unified spend attribution view (plugin / user / subagent / system), telemetry payload preview moved off the SvelteKit form-action surface, mechanical `requestId` sweep across 150 audit callsites + lint to keep them honest.

[Unreleased]: https://github.com/caelo-cms/caelo-cms/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/caelo-cms/caelo-cms/releases/tag/v0.1.0
