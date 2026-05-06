# Changelog

## v0.2.3

_no changes since last tag_

## v0.2.2

### Fixes
- 9b050e7 publish @caelo-cms/shared + rewrite workspace deps in CI

## v0.2.1

### Features
- febb974 release-check sidecar — no network in DB transactions
- 82371d5 cosign verify in upgrade pre-flight
- a2fdb44 run DB migrations during upgrade (idempotent)
- 2a49399 two-phase upgrade with health probe + auto-rollback
- 6f78a6a in-admin upgrade notifier via notification bell
- 55e5421 versioned upgrade + status latest-release check
- b1ff6ea compose_from_import + /ramp-up wizard + dashboard hero
- f1a0984 create_template tool + UUID context + create_page templateId optional
- edfc48b drain legacy caelo_admin user before pulumi-up
- f331ca4 wire CAELO_SECRET_KEK + drop required Anthropic key
- b98baa2 /security/ai password input + clear-key + first-run redirect
- 18ef4e3 ProviderResolver + rewire 4 callsites to DB-backed keys
- 46fe0d3 encrypted at-rest API keys + clear_key + any_configured
- e53de0b AES-GCM secret-box helper + dev KEK auto-gen
- 65b29f3 wizard runs DB migrations via one-shot Cloud Run Job
- abc06e7 wizard uploads animated welcome page to static bucket
- 0b92526 caelo-cms lifecycle commands (§11.C commit 5/6)
- e5deb77 wizard DNS auto-create adapters (§11.C commit 4/6)
- aa8c80c wizard cost-estimate + Pulumi automation + IAP enable (§11.C commit 3/6)
- a2712d4 cms-provision wizard — GCP bootstrap automation (§11.C commit 2/6)
- f2cb1f5 cms-provision wizard scaffold (§11.C commit 1/6)
- ef743f8 pre-built admin + gateway images via GHCR — first §11.C deliverable
- d3200a8 docs-site/ content tree + sync script (PR 2A)
- a03b046 plugin host, gateway hardening, provisioning, multi-provider AI, OSS launch hygiene
- 9c7ef9d subagents — same chat-runner, called recursively via spawn_subagent
- 15f67c6 skills system + auto-engagement + base skills
- 8364f00 AI translation Mode 1 + Mode 2 + bulk dashboard + glossary + style guide
- e607b0e i18n foundation — locale registry, URL strategies, propose/execute gate
- 48394a0 SEO sidecar + sitemap.xml + multi-format redirects + slug-change link rewriter + fill-once/optimize AI tools
- 64abae0 five optimizations — responsive srcset+LCP preload, focal/crops, storage-plugin seam, processing status, AI alt proposals
- eef6a9b media library — upload pipeline, sharp variants, AI awareness, deploy-time asset copy, CDN-copy toggle
- b69d086 layout block editor + drag-and-drop on page editor + side-by-side iframe diff
- 8a074fd admin UX interactivity — deploy polling, Cmd-K palette, vim shortcuts, notification bell, onboarding tour
- 1344511 admin UX foundation — empty states, skeleton, inline Zod, axe-core AA gate, brand, motion-reduce
- 27ae90e content ops — duplicate, change-template, reorder/move modules, structured-sets editor
- d247852 layouts (site-wide chrome) + multi-layout + site_defaults + no-fallbacks invariant
- a464e34 pages lifecycle (name/title/slug split) + structured-data sets + redirects scaffold
- 3f4feee live-edit UX polish — page-bound chats, in-toolbar publish, markdown page context
- 0249399 add_module_to_template — site-wide module fan-out
- f759dc9 edit-mode toggle, page-aware AI, add_module_to_page tool, error surfacing
- e464da1 chrome-less live-edit, latest-snapshot picker, modifier-gated clicks
- 95e5ad4 close 7 live-edit overlay gaps surfaced in P6.7 audit
- dcd3081 live-edit overlay — flagship UX with branch-aware iframe + element-click chips
- 9ed456c admin UI follow-up — typed ChatPanel, toasts,  Select wrapper, clickable breadcrumbs, EmptyState
- 38f8c14 admin UI framework — Tailwind 4 + shadcn-svelte
- 41f2938 deploy hardening — subprocess generator, content-addressed  builds, async progress, preview/confirm publish, rollback
- 201622e Caddy hosts + staging gate + chained MVP spec
- 9f3cd0b chat-runner hardening — provider injection, abort,  idempotency, prompt-cache, partial publish
- 075fafc static generator + Publish + Ops dashboard — MVP complete
- c97ce8b chips + visual diff + fixture-replay + missing tests
- f7957da admin chat UI + SSE endpoint + filled security panels
- 6e424a1 chat + memory + provider config + ai_calls Query API ops
- 0e70876 AIProvider abstraction + tools + chat-runner
- 033c5fb AI chat schema + Zod tool surface + ctx.chatBranchId
- a66309c Advanced History drawer + per-entity history routes
- b1b5f52 snapshot Query API ops + op_kind + archival hook
- b3cc8e3 snapshot helpers + emit wiring on every P3 mutation
- 9547a10 snapshot schema (5 tables + RLS + cascade)
- cc828ec follow-up — version + soft-delete cascade + htmlparser2
- 92e05a4 content admin UI under /content
- 66c8ff6 content Query API ops + preview composer
- 564a701 content schema + Zod validators
- f9c0ad4 admin shell + session auth + Owner/Editor/Reviewer + custom roles
- f8e4e53 database + Query API foundation with RLS

### Fixes
- ca0f01b tag-prefix bug + lockstep CI gate + RELEASING.md docs
- 6d66e5d lifecycle commands resolve Pulumi-suffixed names + bump 0.1.2
- f7ca4c1 wire correct DB URLs per service
- aaa914a drain script async-IIFE wrapper + proven SQL
- 5900ca9 resolve VPC from network-interfaces annotation
- 99f1f26 drain step grants role membership + aborts on fail
- efb2492 SecretIamMember tracks Secret resource (depends-on)
- 3a81c37 create admin_role + public_role SQL users (not caelo_admin)
- 6c3ddb1 build-time bun shim re-exports globalThis.Bun (not throws)
- 83b0eea apply globalThis.Bun pattern to migrate.ts + gateway server
- 7d9182e read SQL/Glob from globalThis.Bun, drop bun stub package
- bab6b06 externalize 'bun' at the rollup layer, not just ssr.external
- f151bbd exact-tag match without gcloud filter
- 868e374 pin Cloud Run images by sha256 digest, not floating tag
- 0aba809 drop the build-time bun stub from runtime image
- 12924ec provision IAP service identity + grant run.invoker
- bdf7c83 wizard polls managed TLS cert until ACTIVE
- f857b79 add HTTP→HTTPS redirect on the LB
- ae87575 use Google-managed IAP, drop deprecated Brand+Client
- 9a0117b grant compute.admin + logging.configWriter to provisioner
- 4c3b883 IAP role on iap.web (not Cloud Run); domain verify pre-flight
- a34361d include apps/<service>/node_modules in runtime images + read PORT
- 23b4815 copy GHCR images via local docker pull/tag/push
- 271f2a1 copy GHCR images via wizard gcloud step, not Pulumi Command
- 15f0cdb copy public GHCR images into operator-owned AR
- 8f9be6b proxy ghcr.io via Artifact Registry remote repo
- 0a5b713 make captcha PoW wrong-nonce test deterministic
- 54de983 xargs-driven scan for ALL linux-x64 native bindings
- 8fd5a25 pin @rolldown/binding-linux-x64-gnu to actual version 1.0.0-rc.17
- 49135b2 hardcode native-binding list in one npm install
- fe7a950 batch all native-binding installs into one npm call
- e41d270 install ALL linux-x64 native bindings via bun.lock scan
- a062427 stub node_modules/bun + use bun x (no JIT) for vite build
- eb4e28a rm Bun's wrong-platform symlink before copying real binding
- f576de4 npm install rollup binding in /tmp, copy into apps/admin
- 950c359 use npm to patch the Rollup native binding install
- 193bd12 apt-install curl in oven/bun:1.3 builder
- 5690f0b grep the resolved rollup version, not the spec
- be44a48 build admin in Docker (oven/bun:1.3) with manual Rollup binding
- 03ea19d install rollup + native binding directly into apps/admin/node_modules
- 1ad9a77 manual Rollup native fetch + drop bun --bun from build script
- cf01e57 pre-build admin natively on the runner instead of inside Docker
- 597463c root-install Rollup native + bypass bun --bun for vite build
- 648d75e single-arch (amd64) + explicit Rollup linux-x64 binding
- 198f150 declare @caelo-cms/shared as a workspace dependency
- 3bf8694 clear remaining biome lint errors + pin Rollup native binaries for cross-arch admin builds
- ddfba93 drop --frozen-lockfile in admin Dockerfile (multi-arch Rollup binding)
- b726a3d GCP stack defaults to ghcr.io/caelo-cms images (§11.C contract)
- f002cc3 CI uses @caelo-cms/admin filter, not the pre-rename @caelo/admin
- 2b9afb6 expired-bucket conflict resets window + count atomically
- 6b718ab widen variant type to string for cropped variants
- 6e39c8e declare @caelo/admin-core as static-generator devDep for media-pass test
- e9a2784 self-seeding site_defaults migration for CI
- 933c338 use:enhance on publish forms — refresh no longer re-fires confirmPublish
- 2537c61 make Playwright smoke a real setup → login → dashboard flow
- f6ef54e exclude build artifacts from Biome includes
- b8d3e9a build under Bun + lazy DB-adapter init
- 0a08ef2 start adapter-bun output under Bun, not `vite preview`
- a29699b rename Playwright spec to *.browser.ts so `bun test` ignores it
- 59ff4b1 split CREATE DATABASE into separate psql invocations

### Refactors
- 68a7adc admin via LB BackendService + IAP, drop DomainMapping
- 854b78d images live in Caelo-team public AR; drop wizard copy
- 8e74f86 provisioning contract — CLAUDE.md §11.B + §11.C, 3-tier GCP rewrite
- 2fae5db rename @caelo/* → @caelo-cms/* (npm scope)
- 2d8007a optimization pass — live event streaming, bounded concurrency, in-loop cost cap, ephemeral session GC, subagents prompt hint
- 85dd6e0 review pass — AI-managed glossary, ai_calls integration, module snapshots in Mode 2, job revert + publish-completed, missing tests
- 5d0c2d9 optimization pass — trailing-slash align, bulk hreflang, translation_status_matrix, language-selector
- 75acba4 review pass — translation_status enum align, hreflang published filter, locale-aware output path, redirect creation on execute
- d047b40 AI-first cross-phase pass 2 — open content-curation ops, justify narrow scopes
- a89404f cross-phase AI-first audit — open list/get to AI, add modules.delete_many + media.delete_many, chat session search
- d7fbc20 AI-first review pass — bulk ops, broader filters, redirects AI surface, system-prompt block
- 386dd48 review pass — preview SEO parity, chat ?prompt= consumer, toPath regex, drop dead op_kind, collapse pages_seo.set
- e99e8ed review pass — orig EXIF strip, dedupe audit, /edit Cmd+M, duplicate-page usage delta, 5 verification tests
- e587c6c polish — version-conflict dialog, branch-edited modules, deferred-load streaming, aria-live, ? shortcut
- e79de01 closing pass — forced-colors, brand assets, Zod on 3 forms, diff guard, seed onboarded_at, Skeleton usage
- 3c57d2b review pass — duplicate filters dead modules, system-prompt guidance for 5 new tools, structured-editor form-state preservation
- 4af3723 review pass — narrow AI template scope, parser-based layout validation, owner UIs

### Docs
- 2c8c5c8 explain why Node-20 advisory persists despite force-flag
- b0cf2b5 add §11.A human-confirmation gate for hard-to-revert ops
- a44f869 replace inline §1 diagram with dedicated ARCHITECTURE.md
- 101bd82 focus the §1 diagram on content-layer wiring
- f723448 add architecture-at-a-glance diagram to §1
- 162e1c4 finalize phase plan to mirror what shipped
- aca47b6 finalize phase plan to mirror what shipped
- fe0b9ee finalize phase plan to mirror what shipped
- 9900038 mark phase complete with remote CI run reference
- 0f19592 mark phase complete with remote CI run reference

### Chores
- d7bceeb align everything to v0.2.0 + improve release script
- a2fdc7f opt all JS-based actions into Node 24 runtime now
- 6923bab trigger release-images for new GCP AR mirror
- f5f0e12 biome auto-format — collapse stepCopyImages signature + gcloud array
- 8d15ebd biome auto-fix sweep — import sort + useLiteralKeys (CI lint repair)
- 7d8b332 npm-publish-ready packaging for @caelo-cms/{mcp-server,provisioning}
- 119f952 follow-up 2 — explicit init, audit shape, rotating CSRF, Postgres rate-limit, soft delete
- 97827ba follow-up — security panel stubs, user mgmt, audit, CSRF, rate-limit, Playwright, svelte-check
- a774e92 follow-up 2 — typed tx, role verify, committed RLS SQL, parameterised set_config, reusable adversarial matrix
- ba2c58f follow-up — rollback test, RateLimiter stub, public_role coverage, CI bootstrap.sh, meta-table RLS
- 287699f hardening — secrets, project refs, license check, TS 6, bun-native test runner

### Tests
- 6fb87fb update mcp.integration.test.ts to new resolveProvider shape
- 8b21882 Playwright history-drawer flow
- 351b554 Playwright E2E + dev-owner seed + globalSetup

### Other
- 8118d2c atomicity — release.yml chains docker + npm + verify
- 3c618c8 npm publish + GitHub Release on v* tag push
- 59a8584 mark Playwright job continue-on-error pending server-side smoke fix
- 07f7113 first commit

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
`@caelo-cms/plugin-sdk` + `@caelo-cms/plugin-sandbox` (oxc-parser validator + Ed25519 manifest verifier + Deno subprocess wrapper) + `@caelo-cms/plugin-host` (Tier 1 in-process loader + capability factory). Tier 1 = core plugins, signed, in-process, full SDK; Tier 2 = AI-authored / Owner-installed at runtime, Deno-sandboxed, locked SDK (only `cms_public.<slug>` schema, no AI provider, no chat-runner tool registration). Activation: Tier 1 auto on signature verify; Tier 2 Owner-click per `active` transition.

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
