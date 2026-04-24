# Caelo CMS — Master Implementation Plan

## Context

The repo currently contains only `CMS_REQUIREMENTS.md` (v1.2, Apr 2026) — this is a pure greenfield project. The requirements describe an AI-first, open-source, self-hostable CMS with a layered permission model, module/template/snapshot architecture, cms_admin + cms_public database split, mixed-strategy i18n, a Deno-sandboxed plugin system, and Pulumi-based one-click provisioning across self-hosted/GCP/AWS/Azure.

Scope is large enough that a single plan file cannot drive execution. This document is the **master plan**: a phase index that names every phase, its goal, deliverables, and dependencies. Each phase will get its own detailed phase file under `/Users/michaelweber/.claude/plans/caelo-cms/phase_<N>_<slug>.md` once this master plan is approved and execution begins.

### Scoping decisions (confirmed with user)
- **Output shape:** master plan + separate phase files (phase files created after approval).
- **First runnable target:** thin end-to-end MVP. Earliest phases must deliver a runnable product (login → AI edits a module → preview → deploy static HTML locally), before i18n/plugins/cloud.
- **First provisioning target:** self-hosted via Docker Compose. Cloud providers are a later phase.
- **Detail level:** 1-paragraph summary per phase in this master plan. Full phase files (tasks, schemas, file paths, tests) written on demand when each phase starts.

### Phase map (dependency flow)

```
P0 Bootstrap
  └─ P1 DB + Query API ──┐
                         ├─ P2 Admin shell + auth ──┐
                         └─ P3 Content model ───────┼─ P4 Snapshots (+ A/B sibling variants, chat-branch reservation) ──┐
                                                    │                                                                  │
                             P5 AI + module edit + chat sessions + click-to-chat + visual diff ─────────────────────────┤
                                                                                                                        │
                             P6 Static gen + local deploy (emits A/B variants) ─────────────────────────────────────────┤  ◀── MVP complete
                                                                                                                        │
  ┌───────────────────────────────────────────────────────────────────────────────────────────────────────────────────── ┘
  │
  ├─ P7 Media
  ├─ P8 SEO (fill-once + seo-optimize) + Redirects + sitemap/robots
  ├─ P9 i18n foundation ─── P10 AI translation
  ├─ P10A Skills system + auto-engagement + base skills (+ scoped-edit, seo-optimize, import-site, site-memory-learner)
  ├─ P11 Plugin SDK + Deno sandbox + oxc-parser ── P12 Built-in plugins ── P12A Extended built-in plugins (scheduled publish, kits, typed content, analytics + A/B experiments) ── P13 Static+delta + auto-redeploy + gateway hardening (+ A/B edge split)
  ├─ P14 Pulumi self-hosted provisioning (+ Site Import Wizard with screenshot diff) ── P15 Cloud adapters (GCP/AWS/Azure + A/B edge rules)
  ├─ P16 Additional AI providers + cost dashboard + observability
  └─ P17 Docs + OSS release
```

---

## Phases

### Phase 0 — Repo bootstrap, tooling & CLAUDE.md
Initialise the Bun monorepo (`apps/admin`, `apps/api-gateway`, `apps/static-generator`, `packages/shared`, `packages/query-api`, `packages/plugin-sdk`, `packages/provisioning`). Add TypeScript (strict), Biome, Zod, a root `docker-compose.yml` with PostgreSQL, and a minimal GitHub Actions CI (lint + typecheck + test + license-check). **Test runner: Bun native `bun test`** (no Vitest — drops ~40 transitive deps, matches the natural `bun test` instinct, aligns with CLAUDE.md §3 dependency minimalism). **Also write `CLAUDE.md` at the repo root** capturing the project-wide engineering principles any Claude session (or human contributor) should follow — see "CLAUDE.md contents" section below for the full spec. Deliverable: `bun install && docker compose up -d && bun run lint && bun run typecheck && bun test && bun run license:check` all green on an empty scaffold; `CLAUDE.md` reviewed. No app logic.

**Phase 0 hardening — follow-up pass 2 (P0.2)**
Targeted cleanup before P1 starts, addressing two gaps surfaced in review:
- **Lockfile freshness gate in CI.** A dedicated `lockfile` job runs *before* the main `check` job: `bun install` (without `--frozen-lockfile`) then `git diff --exit-code bun.lock package.json apps/*/package.json packages/*/package.json` — fails with a clear message ("run `bun install` to refresh `bun.lock`") if anyone bumped a version without regenerating the lockfile. The main `check` job then uses `--frozen-lockfile` as today.
- **Drop Vitest, adopt `bun test`.** Remove `vitest` + `vitest.config.ts`; rewrite the seed test to import `describe`/`it`/`expect` from `bun:test`; change root `package.json` scripts from `"test": "vitest run"` to `"test": "bun test"`; remove the `"test:watch"` entry (Bun's `--watch` flag covers it). Zod stays; seeds still pass; about 40 transitive deps disappear. CONTRIBUTING.md / CLAUDE.md §6 gains a one-liner: *"Tests: `bun test` or `bun run test`. Don't add Vitest back — use Bun's runner."*

Ship P0.2 alongside pushing the prior hardening pass (secrets hygiene + `tsc -b` + license check + TS 6.0.3 bump) to `origin/main`. Two conventional commits (`chore(phase-0): hardening pass 1 — secrets, project refs, license check, TS 6` and `chore(phase-0): hardening pass 2 — lockfile gate, bun-native test runner`), then watch CI go green on the remote. Mark P0 closed in the phase stub once the remote CI run succeeds.

### Phase 1 — Database + Query API foundation
Provision two databases (`cms_admin`, `cms_public`) with two isolated PostgreSQL roles (`admin_role`, `public_role`) and a migration tool (drizzle-kit or Atlas). Build the Query API layer: typed named operations → Zod Validator → Database Adapter → PostgreSQL. **Row-Level Security (RLS) enabled and `FORCE`d on every table in both databases** (per-actor scoping in `cms_admin`, per-plugin scoping in `cms_public`) per requirements §12.3. Only `cms_admin` schema scaffolded here (tables come later). Deliverable: undefined operations fail closed; `public_role` proven to have zero privileges on `cms_admin`; RLS adversarial tests fail closed. Unblocks P2, P3.

### Phase 2 — Admin shell, auth, security control panel
SvelteKit + `svelte-adapter-bun` admin app. Session-based email/password login, **built-in Owner/Editor/Reviewer roles plus Owner-defined custom roles** (§9.1), role-gated routes driven by a fixed permission catalog (routes check permissions, not role names). Scaffold the security control panel (stub sections: AI provider config, domain settings, cost controls, user management) — *non-AI*, admin-only. Deliverable: fresh install → owner signup → login → land on empty dashboard; Owner can define a custom role with a reduced permission set and it is enforced. OAuth deferred to the auth plugin in P12.

### Phase 3 — Module, Template & Page content model
Implement the three content primitives via Query API only: `modules` (HTML+CSS+JS, live-referenced), `templates` (named blocks), `pages` (ordered list of module references — no raw HTML field). Admin UI for CRUD. Enforce at the Validator layer that pages cannot contain raw HTML. Deliverable: manually create a module, a template, assemble a page from modules, render a preview.

### Phase 4 — Snapshot versioning + revert (+ A/B variant support)
Add `site_snapshots`, `page_snapshots`, `module_snapshots` tables with appropriate indexes. Every write through the Query API emits a snapshot for affected entities. **UX simplifications (UX-2, UX-9, UX-10):** chat-keyed Undo/Redo primary; task-grouped timeline; visual severity-grouped impact preview; per-module/per-site revert moved to Advanced History drawer. **Module A/B variants** ride on the same snapshot model — variants are sibling `module_snapshots` tagged with an `experiment_id`; no new versioning concept. Winner promotion = standard per-module revert to the chosen snapshot. Traffic split configured at deploy (edge layer performs the split). Deliverable: chat-keyed Undo reverts atomically; Advanced History drawer exposes per-site / per-module revert; A/B sibling snapshots co-exist and are promotable via revert.

### Phase 5 — AI provider abstraction + first AI module edit (Claude)
Provider abstraction layer configured only via the security control panel (never AI-accessible). Claude (Anthropic SDK, Opus 4.7). Token accounting. Admin AI chat UI. First AI capability = edit one module via structured tool calls (no raw HTML writes to pages). **UX simplifications (UX-3, UX-8):** live preview auto-apply + "Publish changes" pill batching; provider brand hidden from chat UI. **Per-site AI session memory** (`site_ai_memory`): Owner-curated brand voice / tone / banned phrases / recurring instructions, prepended to every AI call, versioned in snapshots; **AI may propose memory additions** mid-conversation, which land in the Owner review queue. **Chat sessions model:** `chat_sessions` + `chat_messages` tables, "New chat" button + chat-history sidebar (auto-title, renameable), resume restores engaged skills. **Ephemeral chat branches:** each chat operates on its own preview branch of the snapshot tree so parallel editors don't collide; merges into main only on publish. **Click-to-chat element references:** every rendered element in the preview pane exposes an inline "Edit in chat" pencil; clicking appends an element-reference chip to the *current* chat composer (stable selector + module id + current content), not a new chat. Multiple clicks append multiple chips — user can select five elements then send "make them all green" in one turn. The `scoped-edit` skill (P10A) auto-engages when chips are present. **Visual content diff:** preview pane overlays red/green visual diff (not just code diff) on proposed AI changes, reusing the P4 thumbnailer. Deliverable: AI chat edits with live preview + Publish pill + hidden provider; brand-voice memory shapes output; new chat + history sidebar + resume; two editors in two chats do not collide (ephemeral branches); click-to-chat chips accumulate and round-trip through one AI turn; visual diff overlay toggles on.

### Phase 6 — Static generator + local deploy (MVP complete)
Astro-based static generator that reads pages/modules from `cms_admin` via the Query API and outputs `dist/` of plain HTML/CSS/JS. Three-environment model (§16.5); Deployment Layer trigger-only (§3.1); UX-4: editors see Draft → Live, Ops users see dev/staging/production. Single locale, no plugin data baking yet. **Reserves hooks for P4 A/B module variants** — when an experiment is active for a module, the generator emits *all* variants into the deploy output under stable variant paths so the edge layer (P13/P15) can perform the split at request time. No split happens in MVP deploy — just the emission + routing metadata. Deliverable: **thin end-to-end MVP** — fresh install, login, AI edits a module, preview, Publish (editor view) → Live updates; Ops user sees Draft→Staging→Production and promotes; generator correctly emits A/B variant outputs when fed a synthetic experiment snapshot.

### Phase 7 — Media library
Object-storage abstraction (local volume adapter for self-hosted). Upload endpoint with MIME/size validation. Auto image optimization on upload (sharp → resize variants + WebP). Media browser in admin. AI references media by URL via Query API only (no direct storage access). **Usage tracking + optional deploy-time CDN copy** for frequently-used assets (§10), toggle in admin settings. Deliverable: upload an image in admin, AI places it into a module, deploy renders the optimized asset; with CDN-copy enabled, frequently-used assets served from CDN.

### Phase 8 — SEO, Redirects, sitemap, robots
Per-page SEO fields stored structurally — AI can set fields via Query API, cannot inject raw `<head>` HTML. Redirect manager + admin UI. Static generator: render `<head>` from SEO fields, emit `sitemap.xml`, `robots.txt` (staging noindex), Nginx/Caddy redirect files (provider-specific formats finish in P15). **Revised SEO behaviour (replaces the override-flag design):** AI **fills SEO fields once, before the first publish of a page** via the `seo-autofill` skill. After first publish, the AI never silently overwrites SEO — unrelated content edits leave SEO alone. For (re)optimization the user triggers the **`seo-optimize` skill explicitly** with context — e.g. "here is a keyword analysis for these 5 t-shirt pages, optimize titles and descriptions" — which produces a cross-page preview batched into the Publish pill for one-shot confirm. No per-field override flag is exposed. All included in snapshots.

### Phase 9 — i18n foundation + locale URL strategies
Add `locale` + `slug` unique constraint on pages plus `content_hash`, `translated_from_hash`, `last_changed_at`, `translation_status` fields. Locale config table supporting per-locale URL strategy (no-prefix default, subdirectory, subdomain, separate domain — mixed OK). **Locale config is admin-only — AI actors are rejected at the Validator for every locale/URL-strategy op** (§17.4). **UX simplification (UX-1):** *Default URL strategy is site-wide subdirectory*; subdomain and separate-domain are gated behind an explicit "Advanced URL routing" toggle in the security panel with clear SSL/CDN/hreflang implications and a linter that flags mixed configurations. Most users never leave the simple default. Static generator: emit one file per page per locale; locales without a published translation return clean 404 (no file). Auto hreflang generation across locales. Built-in language selector module (hydrated at deploy with available locale URLs). Deliverable: `en` + `de` both publish with matching hreflang; missing `fr` = clean 404; AI attempts to add/modify locales are rejected and logged; Advanced-routing toggle unlocks subdomain/domain modes with lint warnings on ambiguous configs.

### Phase 10 — AI translation (Mode 1 + Mode 2) + dashboard
Block-level structured diff generator (`changed`/`added`/`removed` by section). Glossary + style guide storage. Translation dashboard: per-page, per-locale status with bulk actions. Mode 1 = new locale variant from source. Mode 2 = update existing translation with full current source + existing translation + structured diff. All AI translations go through standard preview → user confirms → snapshot. Cannot change module structure between locales — only content fields. **UX simplification (UX-5):** *One primary action per dashboard row* — a single "Bring up to date" button that dispatches to Mode 1 or Mode 2 automatically depending on the row's `translation_status`. A single top-level "Auto-translate everything stale" covers site-wide bulk. Granular controls (translate-only vs update-only, per-locale bulk, re-run with different provider) live in an "Advanced actions" drawer. Editors never see a five-button row.

### Phase 10A — Skills system + auto-engagement + base skills
Claude-style skills stored in `cms_admin.skills`. Two distinct levels of "activation": (1) *site-wide* — human Owner required; (2) *per-chat engagement* — auto-matcher + user manual override. Auto-engagement scores site-active skills against user message + chat context; top-K matches engaged per call (bodies concatenated; allowlist union narrows tools). Per-chat Engaged Skills panel with rationale; manual engage/disengage persists for chat life; pinned defaults per user; engagements live on the `chat_sessions` row. AI can draft / update skills through the normal preview → snapshot → confirm path; site-wide activation of a *new* skill requires human Owner confirmation. Behaviour-learned proposals feed an Owner review queue; nothing auto-applies. **Base skills shipped with core:** `compose-page`, `explain-page`, `brand-voice-guard`, `translation-mode-1`/`translation-mode-2`, `seo-autofill` (fill-once), **`seo-optimize`** (cross-page explicit optimization with user-supplied context), `summarize-plugin-data`, **`scoped-edit`** (auto-engages when chat composer has element-reference chips from P5), **`import-site`** (drives the site-import wizard from P14 with screenshot-based design verification), **`site-memory-learner`** (detects repeated user preferences and submits `site_ai_memory` proposals to the Owner queue). Dependencies: P5 (AI + chat sessions + click-to-chat chips), P3/P7/P8 (surfaces). Deliverable: auto-engagement works without user click; Engaged Skills panel shows rationale; manual overrides persist; new chat reverts to matcher defaults; `seo-optimize` on 5 pages with keyword-analysis context produces one cross-page preview; clicking 3 elements + "make them blue" engages `scoped-edit` and updates all three in one turn; `site-memory-learner` queues a memory proposal from repeated corrections.

### Phase 11 — Plugin SDK + Deno sandbox + oxc-parser validator
Plugin SDK (`definePlugin`, `defineComponent`, injected `query`/`api`/`theme`). oxc-parser-based static validator with forbidden-pattern rules (no `fetch`, no `Deno.*` except allowed surface, no dynamic import, no raw SQL). Deno subprocess runner with only the SDK injected — no filesystem, no network. **Web Component frontends mount inside Shadow DOM** (§14.5) so plugin CSS is fully isolated from the host page. **Any plugin table scoped by `page_id` must declare a `locale` column** — Validator rejects schemas missing it (§14.2). Schema declaration drives `cms_public` table provisioning per plugin. **Activation always requires explicit human confirmation** (§17.4): AI can submit a plugin for validation, status moves to `awaiting_activation`, only a human Owner can flip it to `active`. Deliverable: hello-world plugin round-trips through validator + sandbox + Shadow-DOM Web Component + static render; AI-submitted plugin stays gated until human activation.

### Phase 12 — Built-in plugins
Ship the five plugins required by the spec, all built against the P11 SDK: Contact/generic forms; Comments (moderation, locale-aware); Newsletter signups; Ratings/likes (with static average pre-render); Authentication (email/password + OAuth2 via Arctic — Google + GitHub to start, provider credentials from secrets manager). **OAuth2 providers are config entries, not code changes** (§9.2) — add a provider by landing an entry in `oauth_providers.ts` + secrets-manager keys. **AI summarisation/analysis of form submissions and plugin data** (§4) via a read-only `analyze_plugin_data` AI tool with per-plugin field redaction (invoked via the P10A `summarize-plugin-data` skill). **UX simplification (UX-6):** *Built-in plugins install with one click* — AI has pre-run validation against the locked plugin source at release time, so the user sees "Install Contact Form" not a four-step validate → confirm → migrate → activate flow. The multi-step path from P11 remains for any custom / AI-authored plugin. `cms_public` schema materialises here. Auth plugin marked as locked from AI regeneration.

### Phase 12A — Extended built-in plugins (shipped with core, not in core)
Four high-value plugins built against the P11 SDK and shipped bundled with the release, but implemented as plugins (not core):
- **Scheduled publish**: `scheduled_at` on snapshots + cron-driven promoter; editor Publish pill gains "Publish later…"; Ops view exposes the scheduled queue.
- **Component kits**: named module collections (`marketing-kit`, `blog-kit`) with enable/disable/swap semantics; installs into the P3 module registry without schema churn. Enables a "themes" mental model.
- **Typed content model**: lightweight CMS-style types (Author, Product, Event) with references; structured-only. Complements the module/content-block model.
- **Edge-log analytics**: privacy-preserving page-views / referrer / locale dashboard fed from the CDN/Caddy request logs; no cookies, no third-party analytics. **Also feeds A/B experiment results** — variant impressions + engagement events (scroll, click-through, form submit) are aggregated per `experiment_id` + `variant_label` and surfaced in a dedicated Experiments dashboard that reuses the P4 revert flow for winner promotion.

**Skill integration:** each plugin ships a matched base skill — `schedule-publish`, `apply-kit`, `model-content`, `analyse-traffic`. **An additional `ab-analyze` skill** (shipped with the analytics plugin) summarises experiment results in plain language and can recommend a winner (Owner still confirms via revert). Dependencies: P4 (A/B sibling snapshots), P10A (skills), P11/P12. Deliverable: each plugin round-trips end-to-end; Experiments dashboard shows live variant splits from real edge logs; `ab-analyze` summarises an experiment on request.

### Phase 13 — Static + delta pattern, auto-redeploy, gateway hardening (+ A/B edge split)
Static generator bakes approved plugin data into HTML at deploy and injects a `since` timestamp into each Web Component so it only fetches deltas after deploy. API Gateway (Bun-based reverse proxy or Caddy module) with rate limiting per endpoint, CAPTCHA/PoW on public writes, honeypot fields, and strict `public_role` INSERT-only enforcement. Auto-redeploy webhook with 10–15s debounce + admin toggle. **A/B traffic split at the edge:** when the generator emits multiple variants for a module (P6 hook), the gateway/edge layer selects one variant per visitor using a stable hash (cookie or visitor id), records the assignment, and writes a log line consumed by the P12A analytics plugin. Split ratios are read from the experiment record in `cms_admin` and refreshed per deploy. Deliverable: approve comment → debounced build → fresh HTML served; new post-deploy comment appears via delta fetch; a live A/B experiment on the homepage hero produces stable per-visitor assignments and per-variant impression counts visible in the Experiments dashboard.

### Phase 14 — Pulumi self-hosted provisioning + Site Import Wizard
Pulumi TypeScript project in `packages/provisioning`. `bunx cms-provision --provider self-hosted` stands up Docker Compose with PostgreSQL + pgBackRest + Caddy (Let's Encrypt SSL) + MinIO + the CMS services; staging + production as separate vhosts/schemas, staging forced to `X-Robots-Tag: noindex`. **First-run Site Import Wizard:** optional step after provisioning (also re-runnable from admin) — user supplies a URL of their existing site; the `import-site` skill + a sandboxed scrape tool extract structure, draft modules + template blocks + typed content entries, and stage a site snapshot for review. **Screenshot-based design verification:** every imported page rendered in a headless browser and visually diffed against a screenshot of the source URL; side-by-side with pass/warn/fail per page; publish blocked on regressions until acknowledged. Nothing publishes automatically — output is a staging snapshot like any other AI change. Deliverable: fresh Linux box → SSL-enabled staging + production; import an existing site from URL → review screenshots diff → publish to staging; promote to production.

### Phase 15 — Cloud provisioning adapters (GCP, AWS, Azure)
Provider adapters under the same Pulumi umbrella: GCP (Cloud SQL HA, Cloud Storage + CDN, Cloud Run, Secret Manager), AWS (RDS Multi-AZ, S3 + CloudFront, API Gateway + Lambda, Secrets Manager), Azure (Azure DB zone-redundant, Blob + CDN, API Management, Key Vault). Three-environment stacks per provider. Per-locale domain/subdomain SSL and mixed URL strategy routing handled by the adapter. Provider-specific redirect file generators (Cloudflare Pages `_redirects`, CloudFront Lambda@Edge, Azure Front Door) and per-provider CDN asset copy adapters. Admin DNS guidance page (§15.5) surfaces required DNS records per locale domain with resolution checks. **Per-provider edge A/B split adapters** — Cloud CDN / CloudFront (Lambda@Edge) / Azure Front Door rules implementing the same stable-hash split as P13's self-hosted gateway, with assignment logs piped into the analytics plugin. Patroni documented as opt-in HA for self-hosted.

### Phase 16 — Additional AI providers + cost dashboard + observability
Wire remaining providers behind the P5 abstraction: OpenAI + DALL-E, Gemini + Imagen, Ollama / LM Studio / LocalAI / vLLM via the OpenAI-compatible adapter (text + images where supported). AI usage dashboard (tokens + estimated cost per provider over time). **Operation-type limits — independent budgets/caps for text and image generation** (§17.3). Structured audit log for all AI actions + Query API operations.

### Phase 17 — Docs, OSS release prep
**MPL 2.0 LICENSE**, CONTRIBUTING.md, security policy, docs site at caelo-cms.com built with Caelo itself (dogfooding). Public release to github.com/caelo-cms. Quickstart (`bunx cms-provision --provider self-hosted`), admin walkthrough, plugin authoring guide, provisioning runbook per provider. License header on every source file (`SPDX-License-Identifier: MPL-2.0`).

---

## CLAUDE.md contents (written in Phase 0)

A single `CLAUDE.md` at repo root. It is read by every Claude session working in this repo and doubles as a human contributor guide. Structured into numbered sections; each rule has a short *why* so future contributors can make judgment calls instead of blindly following.

### 1. Project identity
- What Caelo is (AI-first OSS CMS), the layered permission model, the two-database split, the module/snapshot architecture. One paragraph each — pointers to the numbered sections in `CMS_REQUIREMENTS.md` for depth.

### 2. Non-negotiable invariants
These cannot be violated by any change, AI-generated or human:
- **No raw SQL anywhere.** All database access goes through the Query API → Validator → Database Adapter chain. If you need a new DB operation, add a named op; do not reach past the API.
- **RLS on every table, both DBs, `FORCE`d for owners too.** Role isolation alone is not enough — per-actor and per-plugin scoping live at the Postgres layer.
- **No raw HTML on pages.** Pages are assembled from module references only. Raw HTML belongs inside modules.
- **No raw HTML into `<head>`.** SEO is structured fields only.
- **Plugins never bypass the sandbox.** Deno subprocess + oxc-parser validator + schema declaration + Shadow DOM on every Web Component — disabling any one is a security regression, not an optimisation.
- **Plugin activation requires human confirmation.** AI submits; human Owner flips to active. No auto-activation, ever.
- **Skill creation/updates follow the same preview → snapshot → confirm path as any other AI change.** New skills additionally require human Owner activation. Behaviour-learned skill proposals are queued, never auto-applied.
- **Skills are the official way to teach AI new behaviour.** Do not hardcode new prompt scaffolding into tool handlers; ship a skill.
- **Two levels of skill activation — never conflate them.** Site-wide activation (human Owner) promotes a skill from `awaiting_activation` to `active`. Per-chat engagement (AI auto-matcher or user manual toggle) decides which active skills augment the current AI call. User manual disengagement in a chat always overrides the matcher for that chat.
- **`admin_role` and `public_role` are isolated.** Never grant cross-database privileges. Never let the API Gateway hold `admin_role` credentials.
- **Auth plugin core logic is locked from AI regeneration.** AI can configure it (protected routes, roles, OAuth provider entries where a human-approved secret exists) — not rewrite it.
- **Locale & URL strategy config is admin-only.** Every locale-config Query API op rejects AI actors at the Validator.
- **Deployment logic is locked from AI.** AI can *request* a deploy via the fixed Deploy op; it cannot modify the generator, deploy scripts, or deploy targets.
- **Every write emits a snapshot.** Reverting a site snapshot must restore both pages and modules.
- **Missing translations = clean 404**, never a fallback. This is correct SEO behaviour.
- **Staging is always `noindex` by default.** Three environments — dev / staging / production — are a first-class part of every deployment, but **editors see only Draft → Live**; the third environment lives in the Ops view.
- **AI provider brand never surfaces in the editor chat UI.** Editors see "AI"; brand only appears in the Owner security panel and the cost dashboard.
- **SEO fill-once, never auto-overwrite.** AI fills SEO fields before first publish via `seo-autofill`; after first publish, content edits never silently rewrite SEO. (Re)optimization happens through the explicit `seo-optimize` skill with user-supplied context, previewed like any other AI change.
- **Click-to-chat chips append, never fork.** Clicking an element's "Edit in chat" affordance adds a reference chip to the *current* chat composer; it does not open a new chat. Multiple chips accumulate for multi-element turns.
- **Chat sessions run on ephemeral preview branches.** Changes from one chat never enter another chat's view until published; publishing merges the chat's branch into main.
- **AI-written site memory is proposal-gated.** The `site-memory-learner` never writes to `site_ai_memory` directly — every suggestion goes through the Owner review queue alongside skill proposals.

### 3. Dependency & version policy
- **Always verify the current version** of a package before adding it — do not trust training-data recall. Fetch the latest stable from the npm registry (or vendor docs via context7) and pin in `package.json`. If the requirements doc specifies a library (Bun, SvelteKit, Astro, Zod, Arctic, Pulumi, oxc-parser, Deno, svelte-adapter-bun, sharp, drizzle/atlas), use it — don't re-evaluate mid-project.
- **Project licence: MPL 2.0.** Maximum freedom for developers, hosting providers, and AI-generated modules; modifications to core files must stay open; patent protection included; one licence, no dual-licensing complexity (same licence as Firefox, Brave, LibreOffice). All dependencies must be **MPL-2.0-compatible** — MPL-2.0, Apache-2.0, MIT, BSD, ISC. GPL/AGPL/SSPL/proprietary deps are blockers and must be rejected in PR review. Record the license of every new dep in the PR description.
- **Prefer fewer, well-maintained dependencies** over clever micro-libraries. OSS contributors will audit this tree.
- **Upgrade, don't pin forever.** Dependabot/renovate on; security advisories block merges.
- **No proprietary SDKs on critical paths** — vendor-neutrality is a core goal. AI providers all sit behind the Provider Abstraction Layer.

### 4. Code quality
- **Refactor when the shape is wrong — no quick fixes, no TODO-for-later hacks, no commented-out code.** If the right fix is three files, do three files; if that's too big for one PR, open an issue and plan it — do not leave the codebase in an interim state. The exception is a truly temporary workaround behind an explicit `// FIXME(issue #N):` pointing to a tracked issue.
- **Root-cause bugs.** Do not paper over symptoms. If a test is flaky, fix the race; do not retry.
- **TypeScript strict.** No `any`, no `@ts-ignore` without a comment explaining why and what unblocks its removal.
- **Zod at every boundary** — HTTP requests, Query API ops, plugin SDK surfaces, AI tool-call arguments. Internal code trusts its types.
- **Small, composable modules.** If a file exceeds ~300 lines, consider splitting. If a function exceeds ~50 lines, consider extracting.
- **Errors are values where it matters.** Use `Result`-like returns at the Query API boundary; throw for genuinely exceptional cases.

### 5. Readability & comments (this is open source)
- **Name things well first.** A well-named identifier removes the need for a comment.
- **Write comments that explain *why*, not *what*.** If a reader can get the *what* from the code, the comment is noise. Good comment: *"Snapshots use live module refs (not pinned versions) because revert must apply atomically across the site — see requirements 3.3."* Bad comment: *"Loop over modules."*
- **Every exported function, type, and module has a short TSDoc block** — one or two sentences of *purpose* + at least one parameter or return note when non-obvious. This is for contributors reading in their IDE.
- **Complex invariants get a block comment** at the top of the file or function. If a reviewer would ask "why is this like this?", the answer lives in code, not PR history.
- **Examples in docs for public-facing APIs** — Plugin SDK, Query API, provisioning CLI. Each should have a runnable example.
- **No dead code.** Delete it; git remembers.
- **No emojis in code or docs** unless a user-facing string genuinely warrants one.

### 6. Testing
- **End-to-end verification per phase is mandatory** (see the verification table in this plan).
- **Three-tier test strategy, enforced per phase** — see the Testing Strategy Matrix below. Every phase declares (a) the unit tests covering its pure logic and Zod schemas, (b) the integration tests covering its Query API ops / Validator rules / Adapter behaviour against a real Postgres, (c) the Playwright E2E flows covering its user-visible behaviour.
- **Coverage gates in CI:** unit ≥ 90%, integration ≥ 80% of declared Query API ops, E2E: every verification-table row has a Playwright script that encodes it and CI fails if any are missing.
- **Every bug fix lands with a regression test** that would have caught it — same tier as the bug (unit/integration/E2E).
- **No mocked PostgreSQL for Query API tests** — run against a real Postgres in the compose stack. Mocks diverge from prod; we've committed to two real databases, tests exercise both.
- **Playwright runs against the real compose stack**, not a dev server in isolation. Every phase adding a screen adds a Playwright flow.
- **Plugin sandbox tests include adversarial cases** — attempts to escape the sandbox must be in the test suite and must fail.
- **Skill behaviour tests:** each base skill has a fixture-driven integration test verifying the skill's output shape (tool calls made, fields populated) against a recorded AI response; also a live test (gated, opt-in, not in PR CI) against the real provider.

### 7. Security posture
- **Secrets never in code or `.env` files committed to git.** Always via the provider-appropriate secrets manager, even in dev (use a local Vault/Doppler/MinIO-hosted fake).
- **Input validation before the Query API, not inside it.** The Validator enforces shape; handlers trust their inputs.
- **Public writes require CAPTCHA/PoW, rate limits, and honeypots.** No exceptions — AI-authored plugin endpoints must honour this.
- **All AI actions and DB ops pass through the audit log.** Logging is not optional; a code path that skips it is a bug.
- **Dependency review on every PR.** New deps justified in the PR description.

### 8. AI-generated code standards
This project is largely AI-authored. AI contributions are held to a *higher*, not lower, bar because they will be reviewed asynchronously by OSS contributors.
- **No half-finished implementations.** If a change introduces a function, it is tested and wired up.
- **Match the permission layer** — a change to the Page Layer cannot add raw HTML; a Plugin Layer change cannot reach the DB directly.
- **Prefer existing modules/utilities** — grep the repo before creating new primitives.
- **Preview diffs must be minimal.** Unrelated formatting churn blocks review.

### 9. Commits, PRs, and reviews
- **Conventional commits** (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`). Each commit is self-contained and passes CI.
- **PR description** always includes: *what changed*, *why*, *which requirements section this satisfies*, *how it was verified*, *licenses of any new dependencies*. The end-to-end verification from the phase file goes here.
- **No `--no-verify`, no force-push to `main`, no squashing away useful history.**
- **Reviewers check:** permission layer respected, Query API only, snapshots emitted, validation present, tests added, docs updated.

### 10. Documentation as you go
- Every phase updates `docs/` when it introduces user-visible behaviour. Caelo's docs site is built *with Caelo itself* (dogfooding from P17) — broken docs block the release.

### 11. When in doubt
- Read the relevant section of `CMS_REQUIREMENTS.md` first — most architectural questions have already been decided.
- If a spec is genuinely ambiguous, open an issue rather than guessing. Do not silently re-interpret.

---

## Phase file layout (to be created after approval)

```
/Users/michaelweber/.claude/plans/caelo-cms/
├── phase_0_bootstrap.md
├── phase_1_db_query_api.md
├── phase_2_admin_auth.md
├── phase_3_content_model.md
├── phase_4_snapshots.md
├── phase_5_ai_module_edit.md
├── phase_6_static_gen_mvp.md
├── phase_7_media.md
├── phase_8_seo_redirects.md
├── phase_9_i18n_foundation.md
├── phase_10_ai_translation.md
├── phase_10a_skills_system.md
├── phase_11_plugin_sdk_sandbox.md
├── phase_12_builtin_plugins.md
├── phase_12a_extended_builtin_plugins.md
├── phase_13_delta_autoredeploy_gateway.md
├── phase_14_provision_selfhosted.md
├── phase_15_provision_cloud.md
├── phase_16_ai_providers_cost_obs.md
└── phase_17_docs_release.md
```

Each phase file will include: goal, dependencies, task list with file paths, schemas and types to add, **testing plan (unit + integration + Playwright E2E)**, exit criteria.

---

## Files to be created (first wave — Phases 0–6 only)

These are the directories the early phases will populate. No existing files to modify since this is greenfield.

- `package.json`, `bun.lockb`, `tsconfig.base.json`, `biome.json`, `docker-compose.yml` (P0)
- `apps/admin/` — SvelteKit + svelte-adapter-bun (P2 onwards)
- `apps/api-gateway/` — Bun HTTP server fronting the Query API (P1 onwards)
- `apps/static-generator/` — Astro project (P6)
- `packages/query-api/` — typed operations, Validator, Database Adapter (P1)
- `packages/shared/` — Zod schemas, types (P1 onwards)
- `packages/migrations/` — cms_admin + cms_public migrations (P1)
- `.github/workflows/ci.yml` (P0)

---

## Reusable patterns from the requirements doc

The spec already commits to specific libraries — the phase files will honour these rather than re-evaluate:

- Runtime: **Bun** (section 18) — every app and script runs under `bun`.
- Admin: **SvelteKit + svelte-adapter-bun**.
- Static output: **Astro + Bun**.
- Validation: **Zod** (section 16.3) for every Query API operation.
- Plugin static analysis: **oxc-parser** with a custom rule walker (section 14.3).
- Plugin sandbox: **Deno subprocess** (section 14.4).
- OAuth: **Arctic** (section 9.2).
- Provisioning: **Pulumi + TypeScript** (section 15.1).
- AI SDK: Anthropic TS SDK for Claude (Opus 4.7: `claude-opus-4-7`), OpenAI-compatible adapter pattern for everything else.

---

## Testing Strategy Matrix

Three tiers per phase. Every phase's phase-file must fill its row. CI blocks merges that drop below declared coverage or omit a required Playwright flow.

**Tooling (decided):**
- **Unit:** Vitest (Bun-native). Pure logic, Zod schemas, codec round-trips, formatters, URL resolvers, diff generators, content-hashers.
- **Integration:** Vitest + real Postgres from the compose stack (no mocks). One DB reset per test file via transactions. Hits the Query API, Validator, Adapter, RLS policies, snapshot emission path, plugin sandbox subprocess.
- **E2E (Playwright):** drives the real admin against the compose stack (Postgres + API gateway + admin + static host). One Playwright script per verification-table row; additional scripts for screen-level flows.

| Phase | Unit | Integration | Playwright E2E |
|---|---|---|---|
| P0 | build scripts, config loader | n/a (no app logic) | smoke: admin serves 200 on `/` |
| P1 | Zod schemas; operation registry | every Query API op; RLS cross-actor/cross-plugin; `public_role` privilege leak | n/a |
| P2 | password hasher; permission resolver | session lifecycle; role/permission middleware; custom-role CRUD | owner signup → login → dashboard; Reviewer blocked from deploy; custom-role creation enforces access |
| P3 | module/page serialisers; raw-HTML detector | CRUD ops; Validator rejects raw-HTML-on-page | compose page from modules; preview renders |
| P4 | severity heuristic; task-group collapser; **A/B experiment tagger on sibling snapshots** | snapshot emission on every write; per-module revert; impact-preview query; **A/B sibling variants co-exist + winner promotion via revert** | edit module → visual impact preview → confirm → chat-keyed Undo restores; Advanced History drawer per-module revert; **A/B variants created + promoted** |
| P5 | token accounting; cost estimator; site-AI-memory templating; chat-title auto-derivation; **element-chip serializer**; **visual diff overlay** | Claude adapter against recorded fixtures; provider abstraction swap; chat session + messages persistence; **ephemeral preview branch per chat**; **AI memory proposal queue** | live preview + Publish pill + hidden provider; brand-voice memory; new chat + history sidebar + resume; **two chats do not collide (ephemeral branches)**; **click 5 elements + one prompt updates all 5 in one turn**; **visual diff overlay toggle** |
| **P6** | env resolver; dist layout; **A/B variant emitter** | deploy op writes correct env dist; staging robots-noindex header; **synthetic A/B experiment → generator emits all variants with routing metadata** | **MVP flow: AI edit → preview → Publish (editor Draft→Live) → live serves; Ops user sees Draft→Staging→Production and promotes** |
| P7 | MIME sniffer; variant planner; usage-counter hook | upload → sharp → storage adapter → media_assets row; CDN-copy selector | upload in admin → AI places image → deploy renders optimized; CDN-copy toggle verified via response header |
| P8 | SEO derivation engine (fill-once via `seo-autofill`); cross-page `seo-optimize` batcher; sitemap builder; robots builder; Nginx/Caddy redirect generators | fill-once guard (no silent overwrite after first publish); `seo-optimize` cross-page preview batches into one Publish pill event | fresh page → AI fills SEO before first publish → user publishes → subsequent content edit does not rewrite SEO; explicit `seo-optimize` on 5 pages with keyword context produces one cross-page preview + one confirm |
| P9 | URL resolver per strategy; content hash; hreflang emitter | locale CRUD rejected for AI actor + logged; hash-on-write + status-recompute trigger | default subdirectory flow works; Advanced URL routing toggle unlocks subdomain/domain; lint flags mixed ambiguity |
| P10 | block-level diff; status state machine | Mode 1/Mode 2 prompt construction from fixtures; glossary/style injection | dashboard row shows single "Bring up to date" button; top-level "Auto-translate stale" works; Advanced drawer exposes granular controls |
| **P10A** | auto-engagement scorer; proposal generator; pinned-defaults resolver; **`scoped-edit` chip interpreter**; **`seo-optimize` cross-page planner**; **`site-memory-learner` pattern detector** | skill CRUD emits snapshots; site-wide activation rejects AI actor; system-prompt composition with engaged skills; per-chat engagement persistence; **memory-proposal queue** | **auto-engagement without user click**; Engaged Skills panel + rationale; manual disengage persists + overrides matcher; new chat reverts to defaults; **`seo-optimize` across 5 pages with keyword-analysis context → single cross-page preview**; **3-element click → "make them blue" → `scoped-edit` updates all three in one turn**; **`site-memory-learner` queues a memory proposal after repeated same-preference rewrites** |
| P11 | oxc-parser rule walker; schema-locale checker; Shadow-DOM component wrapper | sandbox subprocess boundary (fetch/fs/net blocked); activation gate rejects AI; plugin→cms_public migration | hello-world plugin end-to-end; Shadow-DOM CSS-leak test asserts host unaffected |
| P12 | per-plugin schemas; analyze_plugin_data redaction | OAuth config→runtime iteration; Arctic integration (recorded); `analyze_plugin_data` scope limits | each built-in plugin round-trips (submit → moderate → deploy bakes in); one-click install UX; new OAuth provider added by config entry |
| **P12A** | schedule cron math; kit swap diff; typed-content reference validator; analytics aggregator; **A/B experiment aggregator + `ab-analyze` planner** | scheduled promote; kit enable/disable; typed content references resolve at render; analytics ingestion from Caddy logs; **variant-attributed events aggregate per experiment** | schedule a publish; apply + swap kits; typed Product reference flows into list module; analytics dashboard shows real requests; **Experiments dashboard shows live variant split + `ab-analyze` summarises**; companion skills work from natural language |
| P13 | debounce timer; delta since-param parser; **stable-hash variant selector** | static-render pipeline bakes plugin data; `public_role` INSERT-only; rate limiter; PoW/CAPTCHA/honeypot; **gateway reads experiment config, routes by stable hash, emits assignment log** | approve comment → single debounced rebuild → new HTML served; new comment after deploy appears via delta fetch; **live A/B on homepage hero gives stable per-visitor assignments and per-variant impressions flow to the analytics plugin** |
| P14 | Pulumi input validation; **screenshot differ** | compose stack assembles; pgBackRest WAL streaming; promote copy; **Site Import Wizard: scrape → module draft → typed content draft → staging snapshot + per-page screenshot diff** | fresh-VM smoke: provision → staging + production both over SSL; staging noindex; promote flow; **import existing site from URL → review screenshot diffs per page → acknowledge regressions → publish to staging → promote** |
| P15 | per-provider adapter inputs; DNS record formatter; **per-provider edge-split rule emitter** | provider Pulumi stacks dry-run (previews); redirect generators per provider; CDN-copy adapters; **A/B edge-split rules (Cloud CDN / Lambda@Edge / Front Door) emit the same stable-hash behaviour as P13** | GCP/AWS/Azure smoke provisions (nightly, opt-in); DNS guidance page shows correct records + resolution status; **A/B split works identically on all three providers** |
| P16 | cost estimator per model/op-type; budget enforcer | each provider adapter against recorded fixtures; text/image cap independence | dashboard text/image series independent; image cap blocks image calls while text continues |
| P17 | doc build | docs site assembles from Caelo itself | `git clone && bunx cms-provision --provider self-hosted` per README reaches a working install |

**Cross-cutting Playwright flows** (run against every merged PR, not tied to one phase): full MVP replay (P6 row); AI "compose page" happy path (P10A row); permission-layer adversarial flow (editor attempts Owner-only routes, all denied).

---

## Verification strategy per phase

Every phase file will specify a concrete *end-to-end* check — not just unit tests — aligned to these anchors:

| Phase | End-to-end verification |
|---|---|
| P0 | `bun install && docker compose up -d && bun test` green on empty scaffold |
| P1 | Manual Query API call succeeds; undefined operation rejected; cross-DB role leak fails closed; **RLS adversarial tests fail closed (cross-actor + cross-plugin)** |
| P2 | Fresh install → owner signup → login → reach dashboard; Reviewer cannot reach deploy route; **Owner creates a custom role with reduced permissions → enforced** |
| P3 | Create module + template + page composed of modules; preview renders; raw-HTML-on-page write rejected |
| P4 | Edit module → **visual impact preview grouped by severity** → confirm → **chat-keyed Undo** restores prior state incl. module; Advanced History drawer exposes per-site / per-module revert |
| P5 | AI chat edits a module; **live preview auto-applies, "Publish changes" pill batches diffs**; provider brand absent from chat UI; **per-site brand-voice memory demonstrably shapes output across sessions; AI proposes memory additions → Owner queue**; **New chat + history sidebar + resume a prior chat restores its state**; **two parallel chats do not collide (ephemeral branches)**; **clicking 5 elements + "make them green" updates all five in one AI turn**; **visual red/green diff overlay on preview pane** |
| **P6** | **Full MVP with simplified UX: fresh install → login → AI edit → live preview → Publish (editor view: Draft → Live); Ops user sees Draft→Staging→Production and promotes** |
| P7 | Upload image → optimized WebP variants present → AI references URL → appears in deploy; **with CDN-copy enabled, frequent assets served from CDN origin** |
| P8 | **SEO fields auto-filled before first publish and never silently overwritten afterwards**; **explicit `seo-optimize` on 5 pages with user-supplied keyword analysis produces one cross-page preview**; `<head>` rendered; `sitemap.xml` + `robots.txt` + **Nginx/Caddy** redirect file generated; staging has noindex |
| P9 | `en` + `de` variants exist; `/about` + `/de/about` both publish; hreflang links match; missing `fr` is a clean 404; **AI locale-config writes rejected and logged**; **default subdirectory works out-of-the-box; Advanced URL routing toggle unlocks subdomain/domain with lint warnings** |
| P10 | Edit source page → `de` auto-flagged `needs_update`; **single "Bring up to date" button on dashboard row dispatches to Mode 2**; **one top-level "Auto-translate stale" works**; translation preview → confirm → snapshot |
| **P10A** | **Auto-engagement works without user click; Engaged Skills panel + rationale; manual disengage persists + overrides matcher; new chat reverts to defaults; `seo-optimize` across 5 pages with keyword-analysis context → one cross-page preview; 3 element clicks + "make them blue" → `scoped-edit` updates all three in one turn; `site-memory-learner` queues a memory proposal; Owner approves → site-wide-active** |
| P11 | Hello-world plugin: validator catches forbidden patterns; **human Owner activates** (AI cannot); **Shadow-DOM CSS leak test passes**; static render works; schema missing `locale` on page-scoped table is rejected |
| P12 | Each built-in plugin round-trips: submit data via public API → admin → approve → baked into next deploy; **one-click install for built-ins (no multi-step validate/confirm/migrate/activate)**; **new OAuth provider added via single config entry + secret**; **`analyze_plugin_data` returns a bounded summary with audit entry** |
| **P12A** | **Scheduled publish fires at target time; component kits enable/swap without schema churn; typed content reference (Product) flows into a Product list module; analytics dashboard populates from real edge logs; Experiments dashboard shows live A/B variant split with per-variant events; `ab-analyze` skill summarises the experiment; each companion skill gives AI a one-line natural-language interface** |
| P13 | Approve comment → debounced rebuild fires once → new static HTML served; comment posted after deploy appears via delta fetch; **live A/B experiment produces stable per-visitor variant assignments and per-variant impression counts feed the analytics plugin** |
| P14 | Fresh VM → `bunx cms-provision --provider self-hosted` → **both staging + production over SSL; staging noindex; promote flow**; **Site Import Wizard: point at existing URL → scrape + draft modules/content → per-page screenshot diff review → publish to staging → promote** |
| P15 | Same command succeeds on GCP, AWS, Azure; mixed URL strategy all serving; **provider-specific redirect files validated (`_redirects`, Lambda@Edge, Front Door)**; **CDN asset copy working**; **admin DNS guidance page shows correct records with resolution status**; **A/B edge split behaves identically on all three providers** |
| P16 | Switch provider in control panel → same AI capability works; daily spend cap blocks further calls at threshold; **text cap and image cap enforced independently** |
| P17 | Docs site builds from Caelo itself; `git clone && bunx cms-provision --provider self-hosted` produces a working install per README |
