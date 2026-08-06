# Caelo CMS — Project Requirements Document

**Version:** 1.4
**Status:** Complete (Initial Draft)
**Type:** Open Source
**Licence:** MPL 2.0 (Mozilla Public License 2.0) — maximum freedom for developers, hosting providers, and AI-generated modules; modifications to core files must stay open; patent protection included; one licence, no dual-licensing complexity. Same licence used by Firefox, Brave, and LibreOffice.
**Website:** caelo-cms.com
**GitHub:** github.com/caelo-cms

---

## 1. Project Vision

An open-source, AI-first Content Management System that enables users to design, create, and deploy complete websites through natural language interaction with AI. The system is vendor-agnostic, self-hostable, and deployable with minimal setup on any major cloud provider. Plugins are built in-house by AI, running in a secure sandbox — no external plugin ecosystem.

---

## 2. Core Goals

- Allow users to manage the full website lifecycle (design, content, images, deployment) via AI interaction
- Maintain consistency and stability across pages through a structured module and template system
- Separate AI capabilities by layer so the system stays secure and predictable
- Generate clean, static HTML at deployment for maximum SEO and LLM discoverability
- Pre-render plugin data (comments, ratings, etc.) into static HTML at deploy time — only fetch deltas live
- Support multiple AI providers interchangeably (Claude, Google, OpenAI, custom/local models)
- Support full i18n — language and country/language targeting, mixed URL strategies, AI-assisted translation — via the first-party `international-site` plugin on a locale-agnostic core (§7)
- Be simple to set up — one-click provisioning on AWS, GCP, Azure, or self-hosted
- Be fully open source (MPL 2.0) and avoid vendor lock-in
- Let the AI grow with the site through a Claude-style Skills system — named, versioned, revertible AI behaviours the AI itself can author, with human Owner confirmation for activation
- Use managed cloud services where available instead of self-managed infrastructure
- All plugins are built by AI against a strict SDK — no raw database or SQL access ever

---

## 3. Architecture Overview

### 3.1 Layered Permission Model

| Layer | AI Access | Description |
|---|---|---|
| Module Layer | Full | AI can create and edit reusable HTML/CSS modules |
| Template Layer | Restricted | AI can edit designated template zones (header, footer, nav, content area) |
| Page Layer | Module-only | AI assembles pages using existing modules only — no raw HTML allowed |
| Content Layer | Structured | AI writes content inside predefined fields/blocks, no free-form markup |
| SEO Layer | Structured fields + auto-fill | AI can set meta titles, descriptions, OG tags per page — no raw HTML head injection; auto-fills defaults, user edits become persisted overrides |
| Redirect Layer | Query API only | AI can create and manage redirects via Query API — no direct config file access |
| Plugin Layer | SDK-only, submit-for-activation | AI builds plugins using Plugin SDK only — no direct DB or SQL access; activation always requires human Owner confirmation |
| Skill Layer | Author + propose | AI can draft/update skills and submit behaviour-learned proposals; activation of new skills requires human Owner confirmation |
| Media Layer | Upload + reference | AI can upload to media library and reference assets — no direct storage access |
| i18n Layer | Structured translation (plugin-provided, §7) | Provided by the `international-site` plugin. AI can create and update language variants via translation modes — no structural changes between variants; locale/URL-strategy config is §11.A-gated |
| Security Layer | None | Authentication, user management, access control, custom roles, AI provider config — no AI access |
| Deployment Layer | Trigger-only | AI can request a deploy via admin panel — cannot modify deployment logic, scripts, or targets |

### 3.2 Module System

- AI can create new reusable modules (HTML + CSS + optional JS)
- Modules are stored centrally and referenced by pages
- Pages always use the latest version of each module — live references, not pinned versions
- When AI proposes a module change, the admin panel shows which pages will be affected before confirming
- Modules are included in site snapshots alongside pages — full rollback safety at site and individual module level
- Pages are built by composing modules — AI cannot write raw HTML directly onto a page
- Every module has a stable **`type`** (its reusable class, e.g. `button`) distinct from its unique **`slug`** (e.g. `button-mpqxq3ch`, which carries a uniqueness suffix). The `type` is what nested-composition constraints match against; the `slug` is row identity. New modules derive `type` from their display name unless the AI authors one explicitly (so a second `button` variant can share `type: "button"`).
- A nested-module field (kind `module` / `module-list`) may declare **`allowedModuleTypes`** — a whitelist of module `type`s permitted in that slot, matched against the referenced module's `type` (never its slug). This is the standard parent-declares-allowed-children composition constraint (cf. Gutenberg `InnerBlocks.allowedBlocks`). The op-layer Validator is the single enforcement site; the renderer does not enforce it.

**Template grammar (Mustache subset):**

- `{{fieldName}}` — primitive substitution (text, richtext, url, image, …)
- `{{>fieldName}}` — single nested module reference (field kind = `module`)
- `{{#fieldName}}…{{/fieldName}}` — section iteration (text-list / link-list / module-list)
- **Reserved theme-asset placeholders (v0.11.1):** `{{theme_logo_url}}`, `{{theme_logo_dark_url}}`, `{{theme_favicon_url}}`, `{{theme_social_share_url}}` resolve to the active theme's bound asset URLs at render time (operators bind via `themes.set_asset`; AI authors don't need to declare these as fields). Unbound slots stay loud-raw in output AND emit a `theme-asset-unbound:<slot>` marker — silent empty-src would mask a broken `<img>` tag.

### 3.3 Module Versioning

- Pages use live references to modules — always reflect the latest module state
- Every AI-initiated module change saves a module snapshot as part of the site snapshot
- Reverting a site snapshot reverts all modules to the state they were in at that snapshot
- A single module can also be reverted independently without affecting the rest of the site
- Before any module change is applied, the admin sees an impact preview showing all affected pages

```
Site snapshot #42
├── Page: homepage      (html state at snapshot)
├── Page: about         (html state at snapshot)
├── Module: hero-banner (state at snapshot)
├── Module: nav-bar     (state at snapshot)
└── Timestamp: 2026-04-11T14:00:00Z
```

### 3.4 Template System

- A global site template defines the overall layout (header, footer, navigation, content zones)
- The template is editable but structured into named blocks
- AI can edit within defined blocks (e.g. "update the navigation links", "change the footer color")
- The overall template structure is not fully replaceable by AI in a single action

---

## 4. Admin Interface

- Web-based admin panel built with SvelteKit + Bun
- User interacts with AI via natural language — AI provider brand never surfaces in the editor chat UI (editors see only "AI"; brand appears in the Owner security panel and cost dashboard)
- **Editor UX — Draft → Live:** editors see a two-state flow (Draft ↔ Live). The underlying three-environment model (dev / staging / production) is hidden from editors and exposed in a separate **Ops view** for users holding the `ops_view` permission
- **Live preview + batched publish:** AI edits auto-apply to a live preview pane by default; a persistent "Publish changes" pill batches pending diffs, one confirm per publish event. Destructive / high-impact changes (per severity heuristic) force an inline confirm before auto-apply
- Every AI change tracked as a version snapshot (pages + modules together)
- **Chat-keyed Undo/Redo** is the primary history surface — one backwards/forwards control scoped to the current editing session
- **Task-grouped timeline** collapses consecutive AI actions inside the same chat task into one expandable entry ("Rebuilt homepage hero — 12 changes"); per-action snapshots still emitted for revert fidelity
- **Visual impact preview for module changes:** thumbnails with before/after diffs grouped by severity (low/medium/high); raw-list view hidden behind "Show all affected pages"
- Per-site and per-module revert available in an **Advanced History drawer** for power users
- "Publish / Deploy" button triggers static HTML generation and deployment pipeline
- Auto-redeploy option: when a plugin item is approved, optionally triggers a rebuild — with 10–15 second debounce so bulk approvals trigger one build
- Security control panel (fully separate from AI): login, user roles, **Owner-defined custom roles over a fixed permission catalog**, AI provider config, domain settings, API cost controls (per text / per image independently), **Advanced URL routing toggle**, skill activation queue, skill proposal review queue
- Media library: browse, upload, manage assets; **usage tracking + optional deploy-time CDN copy** toggle
- Redirect manager: create, edit, delete URL redirects
- SEO manager: per-page meta titles, descriptions, Open Graph tags — AI fills once before first publish and never silently overwrites afterwards; a dedicated "Optimize SEO" AI action takes user-supplied context (e.g. keyword analysis) and proposes changes across one or many pages with preview + confirm
- Translation dashboard (provided by the `international-site` plugin, §7): per-page, per-locale status — **one primary "Bring up to date" button per row** (dispatches to Mode 1 or Mode 2 based on status), plus a single top-level "Auto-translate everything stale" for bulk. Granular controls in an Advanced actions drawer
- AI usage dashboard: token usage and estimated cost per provider over time, with independent text / image series
- Form submissions and plugin data viewable in admin — AI can summarize and analyze on request (via the `summarize-plugin-data` skill → `analyze_plugin_data` tool with per-plugin field redaction)
- **Per-site AI memory panel (Owner-only):** brand voice, tone, banned phrases, recurring instructions — prepended to every AI call across sessions
- **Chat sessions — multi-conversation UX:**
  - **"New chat"** button starts a fresh conversation with a clean skill engagement set
  - **Chat history sidebar** lists prior sessions (auto-titled from the first user message, renameable); click any entry to continue it
  - **Engaged skills panel** is visible in every chat — shows which skills are currently augmenting the AI's system prompt, which were auto-engaged by the AI, and which the user toggled manually
  - **Manual toggle:** any site-active skill can be manually engaged or disengaged in the current chat; manual overrides persist for the life of that chat and are not clobbered by auto-engagement
  - **Resuming a chat** restores its engaged-skill set so the AI behaves consistently with where the conversation left off
  - **Ephemeral chat branches:** each chat session operates on its own throwaway preview branch of the site so two editors can work in parallel without collisions. Changes merge into the main branch only when the user publishes from that chat
- **Click-to-chat element references:**
  - Every rendered element in the preview pane exposes an "Edit in chat" affordance (inline pencil icon on hover)
  - Clicking it appends a chip to the current chat composer that references the element (stable selector + module id + current content snippet) — **it does not open a new chat**
  - Multiple clicks add multiple chips; the user can click five elements and then send a single message ("make them all green") that operates on every referenced element in one AI turn
  - Chips are removable before sending; the AI sees the full element context on send
  - The `scoped-edit` skill auto-engages whenever chips are present
- **Visual content diff in preview:**
  - When the AI proposes changes, the preview pane overlays a red/green diff on the rendered page (not just the code)
  - Toggle between visual diff and code diff
  - Reuses the impact-preview thumbnailer so non-technical users can review AI edits at a glance

---

## 5. Version Management

- Simple snapshot-based versioning (not Git)
- Each AI-initiated change creates a snapshot of affected pages AND modules with a timestamp
- Snapshots carry a `chat_task_id` so consecutive changes inside the same chat task group into a single timeline entry while remaining individually revertible
- Snapshots stored in cms_admin database
- User can step forward and backward through snapshots — full site state restored including modules
- **Primary surface is chat-keyed Undo/Redo**; per-site and per-module revert remain available in an Advanced History drawer
- No merge or branch support — single linear history per site
- Fast reads/writes via PostgreSQL with appropriate indexing on snapshot tables (`(entity_id, site_snapshot_id)`, `(chat_task_id)`, `(site_snapshot_id)`)

---

## 6. Deployment & Hosting

At deploy time the static generator:
- Renders one HTML file per page (slug-only paths; plugins reshape URLs via the §7.1 URL composition point)
- Fetches all approved plugin data from cms_public and bakes it into HTML as plain static markup
- Injects a `since` timestamp into Web Components — components only fetch delta data after this point
- Generates redirect files in provider-appropriate format from the redirects table
- Generates sitemap.xml from all published pages; hreflang entries and per-language sitemap additions arrive via the §7.1 head/sitemap contribution points
- Generates robots.txt from admin settings (staging always noindexed by default)
- Uploads all static files to provider-appropriate hosting, respecting the composed URL shape

### 6.1 Static + Delta Pattern

```
Deploy triggered
        ↓
Static generator fetches all approved plugin data from cms_public
        ↓
Data baked into HTML as plain static markup
        ↓
Web Component added with "since" timestamp
        ↓
Page loads in browser — static content visible instantly, zero JS needed
        ↓
Web Component fetches only new items since deploy timestamp
        ↓
New items appended to static content
```

### 6.2 Auto-Redeploy Trigger

```
Admin approves comment / plugin item
        ↓
10–15 second debounce window (batches bulk approvals)
        ↓
Admin panel fires internal POST to deploy endpoint
        ↓
Astro build runs, fetches fresh data from cms_public
        ↓
Static HTML regenerated and uploaded to hosting
```

Auto-redeploy is optional — configurable toggle in admin settings.

---

## 7. Internationalisation (i18n)

> **Status (epic #380, v0.12):** i18n is **not a core capability**. The former core
> implementation — locale registry, per-locale URL strategies, translation modes, hreflang
> emitter, language-selector set — was removed in the v0.12 plugin-system cleanup
> (#381–#385). It returns as the first-party **`international-site` plugin** built on the
> §14 composition-point SDK. This section therefore specifies two things: the small set of
> locale-agnostic **core guarantees** the plugin builds on, and the **behavioural
> requirements** the plugin must satisfy. The behavioural bar is unchanged from v1.x —
> what moved is who implements it.

### 7.1 Core guarantees (what the kernel provides)

Core is locale-agnostic. It ships exactly the primitives an i18n plugin composes:

- **Global-slug page identity.** A page is identified by its slug alone (unique per
  branch); core has no locale column. Language variants of a page are plugin data — the
  plugin groups pages into variant sets in its own schema (§14).
- **Homepage designation in `site_defaults.home_page_id`.** One designated site root; the
  static generator, preview composer, and SEO pass all resolve the root from this single
  pointer.
- **URL composition point** (§14). Plugins contribute declarative, typed URL-shape
  contributions (e.g. a `/de/` path prefix). Core owns the single resolver; slot conflicts
  between plugins fail at activation, never silently at runtime. Any contribution-set
  change (activate / deactivate / reconfigure) is a **migration event**: core materialises
  `pages.current_path`, diffs old vs new URLs, and routes the change through a §11.A
  proposal with blast-radius preview and redirect fan-out — the diff works even after the
  causing plugin is gone.
- **Head + sitemap contribution points** (§14). hreflang link tags and per-language
  sitemap entries are plugin contributions composed by core at deploy time.
- **Generic redirect engine** (§8). Source path → destination path, no locale awareness;
  the plugin creates redirect rows through the same Query API ops as every other actor.

### 7.2 Plugin requirements (behavioural bar for `international-site`)

These requirements bound the plugin, not core. They are the acceptance criteria the v1.x
spec demanded of core i18n and remain non-negotiable:

- **Locale targeting** — language-only (`en`, `de`) and language + country (`de-AT`,
  `en-GB`) variants, coexisting on one site.
- **URL strategy per locale** — subdirectory is the recommended default (`site.com/de/…`),
  with the default locale served bare (no prefix). Subdomain and separate-domain
  strategies are advanced options that must surface their SSL/CDN/hreflang implications
  before activation. Mixed configurations are allowed but linted.
- **hreflang** — generated across all published language variants of a page with absolute
  URLs respecting the active URL strategy; only locales with a published variant appear.
- **Missing translations = clean 404, never a fallback.** No file is emitted for an
  unpublished variant URL, the URL stays out of that locale’s sitemap, and there are no
  `noindex` placeholder pages. Google must never find untranslated content under a locale
  URL. (This is the §2-invariant "no fallbacks" applied to i18n — it survives the move
  into the plugin unchanged.)
- **Context-aware translation — never sentence-by-sentence.** New translations (Mode 1)
  receive the full source page, target-locale context, site glossary, and tone guide.
  Updates (Mode 2) receive the full current source, the full existing translation, and a
  structured block-level diff of what changed — only changed blocks are retranslated, so
  existing translation quality is preserved.
- **Translation-status visibility** — hash-based staleness tracking (source change flags
  dependent variants as needing update) surfaced per page × locale, with bulk
  "bring up to date" actions.
- **Linking between variants** — the plugin maintains the variant grouping and exposes it
  to the AI (which page is the `de` counterpart of `/about`) and to the language-selector
  surface it renders.
- **Review-gated publication** — AI translations go through the standard preview →
  confirm → snapshot path and are fully revertible.
- **Retrofit as a migration** — activating the plugin on an existing single-language site
  moves URLs through the §11.A proposal + redirect fan-out described in §7.1; no page may
  silently change its URL.

### 7.3 AI boundaries in i18n

- Locale/URL-strategy configuration is **hard-to-revert** and follows §11.A: the AI
  drafts the proposal (locale row, URL strategy, fan-out preview); a human Owner approves
  each instance in chat. The AI can never apply locale config directly.
- The AI cannot change page structure between language variants — modules are shared,
  only content fields differ.
- The AI cannot publish a translation without user review and confirmation.

---

## 8. Redirects

- Redirect rules stored as a table in cms_admin: source path, destination path, status code (301/302)
- AI can manage redirects via Query API
- At deploy time, static generator outputs the provider-appropriate redirect file:

| Provider | Format |
|---|---|
| Cloudflare Pages | `_redirects` file |
| AWS CloudFront | Lambda@Edge rules or JSON redirect map |
| GCS / Nginx | Server config rules |
| Self-hosted (Caddy) | Caddy redirect rules |

- Redirects included in site snapshots and fully reversible
- URL-shape migrations (slug changes, plugin contribution changes per §7.1) create their redirect fan-out automatically

---

## 9. User Management

### 9.1 Admin Users (CMS Access)

Managed entirely in the security control panel — completely isolated from AI.

| Role | Permissions |
|---|---|
| Owner | Full access — settings, deploy, content, user management, skill activation, custom-role definition |
| Editor | Create and edit content, manage modules — cannot deploy or change settings |
| Reviewer | Approve plugin items (comments, submissions) — cannot edit content or deploy |

Additional custom roles can be defined by the Owner over a **fixed permission catalog**. Routes check permissions (not role names) so custom roles integrate uniformly. Built-in roles cannot be deleted. A dedicated `ops_view` permission unlocks the Ops view that exposes the underlying dev / staging / production environments and promote controls (see §16.5); without it, users see only the editor Draft → Live abstraction.

### 9.2 Public Users (Site Visitors)

Handled by the pre-built, hardened **Authentication Plugin**:
- AI cannot modify core authentication logic — only configure it (protected pages, roles)
- Supports email/password and OAuth2 (Google, GitHub via Arctic library)
- Provider credentials stored in secrets manager, accessed via injected config interface
- Public user sessions stored in cms_public database under a locked schema
- Additional OAuth2 providers addable by contributors as config entries

---

## 10. Media Management

- Central media library stored in provider-appropriate object storage (S3, GCS, Azure Blob, or local volume)
- AI can upload images and reference them by URL — cannot access storage directly
- Uploads go through a dedicated endpoint with type validation (MIME sniffing, not header trust) and size limits
- Image optimization (resize, compress, convert to WebP) applied automatically on upload
- Admin panel provides a visual media browser
- **Usage tracking** on every media asset (`usage_count`, `last_referenced_at`), incremented by the Query API write path whenever a module or SEO field references the asset
- At deploy time, **frequently used assets are optionally copied to the static hosting CDN for faster delivery**, driven by a usage-threshold + an admin "CDN copy" toggle

---

## 11. SEO Management

- Per-page structured SEO fields in cms_admin: meta title, meta description, Open Graph title/description/image, canonical URL, robots directives
- AI can set these fields via Query API — cannot inject raw HTML into `<head>`
- **Fill-once, never auto-overwrite:** AI populates every SEO field automatically **before the first publish of a page** (via the `seo-autofill` skill). After that point the AI never silently changes an SEO field — even when the page content changes. This protects user-curated SEO from being clobbered by unrelated edits
- **Explicit "Optimize SEO" action:** the Owner/Editor can ask the AI to (re-)optimize SEO for one or many pages at any time via the `seo-optimize` skill. The request carries user-supplied context — for example *"here is a keyword analysis for these 5 t-shirt pages, optimize titles and descriptions"* — and the AI produces a cross-page preview batched in the Publish pill for one-shot confirm
- No per-field override flag is exposed; the model is simply: AI writes the initial value, the user (or the AI via an explicit optimize request) rewrites it, and it stays written until someone rewrites it again
- Fields rendered into static HTML `<head>` by the static generator at deploy time
- Sitemap.xml auto-generated at deploy from all published pages; language variants + hreflang are plugin contributions (§7.1)
- robots.txt generated from admin settings (staging always noindexed, enforced at the provisioning layer via `X-Robots-Tag: noindex` on the staging vhost)

---

## 12. Database Architecture

### 12.1 Single PostgreSQL Installation, Two Databases

```
PostgreSQL Instance
├── cms_admin    (internal access only)
└── cms_public   (API gateway access only)
```

### 12.2 Database Responsibilities

| | cms_admin | cms_public |
|---|---|---|
| Stores | Content, modules, templates, snapshots, redirects, SEO fields, media metadata, admin users, plugin schemas (`plugin_<slug>`, e.g. locale config + translation status for `international-site`), config | Form submissions, comments, plugin data, public user sessions |
| AI access | Read + structured write via Query API | Insert + approved reads via Query API |
| Public access | None — never reachable from internet | Via API endpoints only |
| Direct SQL | Never | Never |
| PostgreSQL role | admin_role (dedicated) | public_role (dedicated) |

### 12.3 Access Isolation

- Two separate PostgreSQL roles — `admin_role` and `public_role`
- `admin_role` has no privileges on `cms_public` tables and vice versa
- API Gateway only ever holds `public_role` credentials
- **Row-Level Security (RLS) enabled and `FORCE`d on every table in both databases** — role isolation alone is not enough. Per-actor scoping in `cms_admin` (policies read `current_setting('caelo.actor_id')`); per-plugin scoping in `cms_public` (policies read `current_setting('caelo.plugin_id')`). The Database Adapter sets these session variables on every connection checkout; they cannot be overridden from inside a query
- No direct SQL access from AI or plugin code — all access via Query API

### 12.4 Database Abstraction Layer

```
AI / Plugin Code → Query API → Validator → Database Adapter → PostgreSQL
```

**Query API** — predefined, typed named operations. Undefined operations do not exist.

**Validator** — enforces schema conformity, scope limits, rate limiting, injection prevention.

**Database Adapter** — translates Query API calls into PostgreSQL queries. Swapping database engine requires only changing this layer.

---

## 13. Database Replication & High Availability

### 13.1 Cloud Deployments

| Provider | Strategy |
|---|---|
| GCP Cloud SQL | High availability with automatic failover (enabled in Pulumi config) |
| AWS RDS | Multi-AZ deployment with automatic failover |
| Azure Database | Zone-redundant high availability |

### 13.2 Self-Hosted Deployments

**Default — pgBackRest WAL streaming backup:**
Continuous WAL streaming to object storage. Point-in-time recovery, zero extra infrastructure.

**Optional — Patroni:**
Full primary/replica with automatic failover. Opt-in, documented as upgrade path — not default.

---

## 14. Plugin System

### 14.1 Overview — Caelo as a plugin host

Caelo is a **plugin host**. Almost every feature beyond the irreducible kernel — translation, SEO, media, scheduled publish, comments, forms, kits, typed content, analytics, even authentication — is a plugin built against the same SDK. The kernel is small on purpose: auth state machine, RLS, the Query API chokepoint, the snapshot system, the chat-runner, the deploy trigger, the plugin host itself. Everything else lives in `packages/plugins/<slug>/`.

The benefit is uniformity: when the AI authors a plugin at runtime, it follows the same shape that ships in core. The AI's mental model has no "core vs. plugin" cliff. The cost is that the SDK has to be honest enough to host a real, complex feature (i18n — the `international-site` plugin, §7) — which is exactly what we want it to be.

There is **no external plugin marketplace**. Plugins are either (a) shipped with the Caelo release as core software, or (b) AI-authored at runtime against the SDK and Owner-activated.

### 14.2 Two tiers — same shape, masked capabilities

Plugins ship in one of two tiers. They use the same `definePlugin` / `defineComponent` SDK shape; the runtime decides which capabilities are exposed.

#### Tier 1 — Core plugins

Shipped with the Caelo release. Audited. Live in `packages/plugins/<slug>/`. Shipped today: `comments`, `forms`, `newsletter`, `ratings`, `auth`. Planned on the same shape: `international-site` (§7), `seo`, `media`, `scheduled-publish`, `kits`, `typed-content`, `edge-analytics`.

- **Activation:** auto-activated on Caelo install via signed manifest (Ed25519 signature shipped with the release). Owner can disable from `/security/plugins` but does not need to click Approve on first run.
- **Runtime:** **in-process** within the Bun host. No Deno subprocess. Zero cold-start tax. Acceptable because the source is audited and shipped with the release.
- **SDK capabilities (full):**
  - Cross-table writes inside `cms_admin` (e.g. `international-site` writing translated content into `pages` + `page_modules` + `modules`).
  - Snapshot emission (every write goes through the existing snapshot path).
  - Chat-runner tool registration — the plugin's `operations` automatically become AI tools, with descriptions sourced from the plugin's manifest.
  - AI provider access — Tier 1 plugins can call the Provider Abstraction Layer (`international-site` needs this for Mode 1/Mode 2 translation prompts).
  - Background workers (translation jobs in `international-site`, scheduled-publish cron).
- **Validator still runs** as defense-in-depth (catches forbidden patterns introduced by a future audit miss); it does NOT gate startup.
- **Updates:** ship with Caelo release upgrades. Pinned to the Caelo version in source control.

#### Tier 2 — User plugins

AI-authored at runtime, or Owner-installed from a vetted repo. Examples: a custom `comments-pro` that adds reactions; a site-specific `event-rsvp`; anything the Owner asks the AI to build.

- **Activation:** lifecycle `draft` → `validated` → `awaiting_activation` → `active` / `disabled`. **Owner click required** for every transition into `active`. No auto-activation, ever.
- **Runtime:** **Deno subprocess** with `--no-read --no-write --no-net --no-env --no-prompt --no-npm --no-remote`. Per-invocation cold start. The SDK + plugin source written to tmp files; import map points `@caelo-cms/plugin-sdk` at the SDK module.
- **SDK capabilities (locked):**
  - **Reads + writes ONLY against the plugin's own `cms_public.<slug>` schema.** No `cms_admin` access of any kind.
  - **No snapshot emission** (plugins write to `cms_public`; that surface has no snapshot model).
  - **No chat-runner tool registration.** The plugin exposes an HTTP-style `run_operation` surface invoked by the API Gateway on public requests; not a tool the AI can call directly.
  - **No AI provider access.** Public-facing plugins should not be calling LLMs from inside a Deno subprocess on the request path.
  - **No background workers.** If a Tier 2 plugin needs cron-style work, the host runs it; the plugin only declares the schedule.
- **Validator runs every load.** oxc-parser walks the source; rejects forbidden patterns (`fetch`, `Deno.*` outside the allowlist, dynamic `import()`, raw SQL strings, `eval`, `new Function`, top-level `globalThis` writes).
- **Updates:** the AI submits a new version through `submit_plugin`; Owner re-activates.

#### What stays in core (irreducible kernel — never a plugin)

- Auth state machine (sessions, password hashing, role resolution, permission middleware).
- Row-Level Security policies.
- The Query API: `defineOperation`, the Validator, the Database Adapter.
- The snapshot system (`site_snapshots`, `page_snapshots`, etc.).
- The chat-runner.
- The plugin host itself (registry, activation gate, validator, sandbox runtime).
- The deploy trigger.

A plugin host that's itself a plugin is a bootstrapping headache. These stay in core.

### 14.3 Tier capability matrix

| Capability | Tier 1 (core) | Tier 2 (user) |
|---|---|---|
| Runtime | Bun, in-process | Deno subprocess, sandboxed |
| Cold-start | none | ~50–100ms per invocation |
| `cms_admin` reads | ✓ (declared scopes) | ✗ |
| `cms_admin` writes | ✓ (declared scopes) | ✗ |
| `cms_public.<slug>` reads + writes | ✓ | ✓ |
| Snapshot emission | ✓ | ✗ |
| Chat-runner tool registration | ✓ (auto from `operations`) | ✗ |
| AI provider access | ✓ | ✗ |
| Background workers | ✓ | ✗ (declare schedule; host runs it) |
| Activation gate | signed manifest, auto on install; Owner can disable | Owner click per `active` transition |
| Validator runs | yes (defense-in-depth) | yes (gates activation) |
| Source location | `packages/plugins/<slug>/` | `plugins.source_code` (DB) |
| Updates | with Caelo release | per `submit_plugin` call |

Tier 2 is Tier 1 with capabilities masked off. The SDK exports the same shapes; the runtime exposes only what the tier permits. A Tier 1 plugin recompiled and submitted as Tier 2 source would fail validation the moment it imports a Tier-1-only capability.

### 14.4 Plugin Structure (shape both tiers share)

```javascript
export default definePlugin({
  slug: "comments-pro",
  version: "1.0.0",
  schema: {
    comments: {
      id: "uuid",
      page_id: "string",
      content: "string",
      status: "enum:pending,approved,rejected"
    }
  },
  operations: {
    submit: async ({ query }, data) => query.insert("comments", data),
    list: async ({ query }, { page_id, since }) =>
      query.list("comments", { page_id, status: "approved", since })
  },
  component: defineComponent({
    tag: "cms-comments-delta",
    async mounted({ api, theme }) {
      const newComments = await api.list({ page_id: this.pageId, since: this.since })
    }
  }),
  staticRender: async ({ query }, { page_id }) => {
    const comments = await query.list("comments", { page_id, status: "approved" })
    return comments.map(c =>
      `<div class="comment"><strong>${c.author}</strong><p>${c.content}</p></div>`
    ).join("")
  }
})
```

Tier 1 plugins additionally declare optional capability requests (`requestedCapabilities: ['cms_admin', 'ai_provider', 'snapshots']`) in the manifest; the host grants them at load time after verifying the manifest signature. Tier 2 plugins MUST NOT declare `requestedCapabilities` — the validator rejects the field.

### 14.5 Plugin Validation — oxc-parser

Custom validator built on oxc-parser (Rust-based, millisecond execution). Forbidden patterns cause immediate rejection with structured error returned to AI for auto-fix and resubmit.

For Tier 2 the validator gates activation (rejection ⇒ status stays `draft`). For Tier 1 the validator runs at startup as defense-in-depth (rejection logs a fatal error and refuses to load the plugin; signed-manifest mismatch is treated identically).

### 14.6 Plugin Frontend — Web Components

- Native browser Web Components — no framework dependency.
- **Shadow DOM is mandatory** on every plugin Web Component — plugin CSS can never leak into the host page, and host CSS never leaks into the plugin. Open mode by default, closed mode configurable per plugin.
- Theme tokens injected as CSS custom properties on the shadow root.
- API client injected by SDK — cannot construct arbitrary HTTP calls.
- Receives site theme tokens.

The frontend rules are tier-agnostic: a Tier 1 plugin's component runs in the browser the same way a Tier 2 plugin's does.

### 14.7 Runtime Split

```
Bun        — CMS host + admin panel + API gateway + static generator + Tier 1 plugins
Deno       — Tier 2 plugin backend execution (sandboxed subprocess)
Browser    — Plugin frontend Web Components (both tiers)
```

### 14.8 Plugin Activation

- **Tier 1:** auto-activated on install via signed manifest. Owner can disable from `/security/plugins` (signature still validated on each enable). Disabling does not drop tables — data is preserved.
- **Tier 2:** lifecycle `draft` → `validated` → `awaiting_activation` → `active` / `disabled`. **Activation always requires explicit human Owner confirmation.** AI can submit a plugin for validation, but only a human Owner can flip it to `active`. No auto-activation, ever.
- **One-click install for Tier 2 plugins shipped with Caelo as samples** (e.g. a starter `event-rsvp`): the manifest is signed; the Owner sees "Install Event RSVP" rather than a multi-step validate/confirm/migrate/activate flow. The full multi-step path remains for custom / AI-authored Tier 2 plugins.

### 14.9 Core plugins (shipped Tier 1)

Required for a working CMS. Auto-activated on install.

- **`international-site`** (planned — epic #380) — the i18n feature of §7: locale registry, URL-shape contributions, variant grouping, Mode 1 + Mode 2 translation, glossary, style guide, translation jobs. AI tools registered automatically from the plugin's `operations`; locale-config writes are §11.A-gated.
- **`seo`** — fill-once + cross-page optimize.
- **`media`** — uploads, sharp variants, optional CDN copy.
- **`scheduled-publish`** — `scheduled_at` on snapshots; cron promoter.
- **`kits`** — named module collections; enable/disable/swap.
- **`typed-content`** — Author / Product / Event types with references.
- **`edge-analytics`** — privacy-preserving pageview/referrer dashboard from CDN logs; feeds A/B experiment results.
- **`contact`** — generic forms.
- **`comments`** — moderation + static pre-render.
- **`newsletter`** — signups.
- **`ratings`** — likes with static average pre-render.
- **`auth`** — pre-built, hardened. **AI cannot regenerate core logic.** OAuth2 providers added via config entries + secrets, not code changes.

Each ships with a companion skill for natural-language invocation (`seo-optimize`, `schedule-publish`, `apply-kit`, `model-content`, `analyse-traffic`, `ab-analyze`, and the `international-site` translation skills, etc.). Companion skills are the AI's "this is how you ask the plugin to do its job" entry point.

### 14.10 Tier-1 plugin source location and upgrade path

Tier 1 plugins live under `packages/plugins/<slug>/` with the same workspace shape as any other internal package. Each ships:

- `package.json` — `name: "@caelo-cms/plugin-<slug>"`, MPL-2.0, depends on `@caelo-cms/plugin-sdk`.
- `src/index.ts` — default export of `definePlugin({...})` calling.
- `manifest.json` — slug + version + signature.
- `migrations/` (optional) — `cms_public` schema migrations applied at the plugin host's first-run for that plugin version.

Caelo upgrades pull in new versions via the standard package upgrade path. Plugin schema migrations apply transactionally on the next host startup; failure rolls back to the previous version of the plugin and surfaces the error in `/security/plugins`.

---

## 15. Provisioning Strategy

### 15.1 Tool — Pulumi with TypeScript

- Infrastructure as code in the same language as the application
- Fully open source (Apache 2.0)
- Supports all major cloud providers

### 15.2 One-Click Provisioning

```bash
bunx cms-provision --provider gcp   # or aws, azure, self-hosted
```

Provisions in a single command: PostgreSQL with HA, API Gateway, static hosting + CDN per domain/subdomain, secrets manager, object storage, SSL/TLS per domain, custom domain configuration.

### 15.3 Provider Adapters

| Component | GCP | AWS | Azure | Self-hosted |
|---|---|---|---|---|
| Database | Cloud SQL (HA) | RDS Multi-AZ | Azure DB zone-redundant | PostgreSQL + pgBackRest |
| Static hosting | Cloud Storage + CDN | S3 + CloudFront | Blob Storage + CDN | Nginx / Caddy |
| Media storage | Cloud Storage | S3 | Azure Blob | Local volume |
| Secrets | Secret Manager | Secrets Manager | Key Vault | Vault / Doppler |
| API Gateway | Cloud Run / API Gateway | API Gateway + Lambda | API Management | Caddy / Kong |

### 15.4 Self-Hosted Path

```bash
bunx cms-provision --provider self-hosted
```

All services via Docker Compose. Single command, no cloud account required.

### 15.5a Module A/B Testing

- Module variants are stored as sibling `module_snapshots` tagged with an experiment id; no new versioning concept — reuses the snapshot system
- Traffic split configured at deploy time (edge layer performs the split; the static generator emits all variants)
- Experiment results (per-variant conversion / engagement events) flow via the edge-log analytics plugin (§14.9)
- Promoting the winning variant is a standard per-module revert to the chosen snapshot — no bespoke promotion flow
- Experiments are Owner-configurable; AI can propose variants but cannot start or stop an experiment

### 15.6 Site Import Wizard (first-run)

- Available during first-run setup *and* as a re-runnable action in admin
- User supplies a URL of their existing site
- The `import-site` skill + a sandboxed scrape tool extract structure, draft modules + template blocks, draft typed content entries, and stage a site snapshot for review
- **Screenshot-based design verification:** the wizard renders every imported page in a headless browser and diffs it visually against a screenshot of the source page. The user sees a side-by-side for each page with a pass/warn/fail indicator; publish is blocked on visual regressions until acknowledged or fixed
- Nothing is published automatically — the import produces a staging snapshot like any other AI change
- Imported assets flow into the media library with usage tracking (§10); SEO fields are populated by `seo-autofill` as per §11

### 15.5 Custom Domain & SSL

- Domains and subdomains configured during provisioning or via admin settings
- SSL/TLS provisioned automatically per domain (Let's Encrypt for self-hosted, provider-native for cloud)
- DNS configuration guidance provided in admin panel per domain

---

## 16. API Security Layers

### 16.1 API Gateway
- Rate limiting, DDoS protection
- Single choke point — static HTML never reaches the database directly

### 16.2 Write Protection on Public API
- Schema enforcement — only predefined fields accepted
- Rate limiting per endpoint
- CAPTCHA / proof-of-work before writes accepted
- Honeypot fields for bot detection
- `public_role` — INSERT only into declared plugin tables

### 16.3 Input Validation
All data validated against strict typed schemas (Zod) before reaching the Query API.

### 16.4 Secrets Management
All credentials in provider-appropriate secrets manager. Never in code or environment files.

### 16.5 Environment Separation
- Development
- Staging (AI admin always targets staging until user publishes — noindexed by default, enforced via `X-Robots-Tag: noindex` at the Caddy/CDN layer)
- Production
- **Editor abstraction:** editors see a Draft → Live flow only. The three-environment model is surfaced in a separate Ops view visible to users holding the `ops_view` permission. This keeps the infra mental model out of content workflows while preserving the safety of the staging gate

---

## 17. AI Integration

### 17.1 Provider Abstraction Layer

All AI calls go through a single provider abstraction layer. Configured in the security control panel — never accessible to AI itself. **The AI provider brand never surfaces in the editor chat UI** — editors see "AI"; brand surfaces only in the Owner security panel and the cost dashboard.

```typescript
{ provider: "claude",  baseUrl: "https://api.anthropic.com",  apiKey: "sk-ant-..." }
{ provider: "openai",  baseUrl: "https://api.openai.com/v1",   apiKey: "sk-..." }
{ provider: "gemini",  baseUrl: "https://generativelanguage.googleapis.com", apiKey: "..." }
{ provider: "custom",  baseUrl: "http://localhost:11434/v1",  apiKey: "ollama" }
```

### 17.1a Per-Site AI Memory

A `site_ai_memory` table stores Owner-curated system-prompt snippets — brand voice, tone, banned phrases, recurring instructions. Every AI call prepends the active memory. Owner-only direct edit; changes are versioned in snapshots. This turns the AI from a single-session tool into a collaborator that remembers the site's conventions across sessions.

**AI-authored memory proposals:** the AI can suggest memory additions mid-conversation when it detects repeated patterns — e.g. *"you've asked me three times to use UK spelling; add that to site memory?"*. Proposals go into the same Owner review queue as skill proposals (see §17A). Nothing is written to `site_ai_memory` without explicit Owner confirmation.

### 17.2 Supported Providers

| Type | Provider | Text | Images |
|---|---|---|---|
| Cloud | Claude (Anthropic) | ✓ | — |
| Cloud | OpenAI / DALL-E | ✓ | ✓ |
| Cloud | Gemini / Imagen (Google) | ✓ | ✓ |
| Self-hosted text | Ollama / LM Studio | ✓ | — |
| Self-hosted full | LocalAI | ✓ | ✓ |
| Self-hosted high-perf | vLLM | ✓ | — |

### 17.3 AI Cost Controls

- **Per-session token budget** — configurable max tokens per session
- **Daily spend cap** — optional estimated cost limit per day
- **Operation type limits** — independent budgets/caps for text and image generation (image cap exhaustion never blocks pending text calls, and vice versa)
- **Usage dashboard** — token usage and estimated cost per provider over time, with separate text / image series and per-actor breakdown

### 17.4 AI Restrictions

- AI cannot write raw HTML directly onto pages
- AI cannot inject into `<head>` — only structured SEO fields
- AI cannot write raw SQL or access the database directly
- AI cannot modify authentication, user management, custom-role definitions, or deployment logic
- AI cannot install or activate plugins without user confirmation — activation is always human-gated
- AI cannot site-wide-activate a newly-created skill — activation is always human-gated (parallel to plugins). AI may *auto-engage* an already-site-active skill in a chat; that is not activation
- AI cannot override a user's manual disengagement of a skill in the current chat
- AI cannot auto-apply behaviour-learned skill proposals — every proposal sits in the Owner's review queue
- AI cannot modify its own provider configuration or cost controls
- AI cannot access media storage directly — only via upload endpoint
- AI cannot apply plugin-owned config whose blast radius spans the site (locale/URL strategy in `international-site`) — such changes are §11.A proposals: AI drafts, a human Owner approves each instance
- AI cannot publish translations without user review and confirmation (behavioural requirement on the `international-site` plugin, §7.3)
- All AI actions are logged and reversible

---

## 17A. Skills System

Claude-style **skills** are a first-class core capability — named, versioned, revertible AI behaviours that extend AI capability without code changes. Skills are the official extension point for teaching the AI new behaviour; new prompt scaffolding must not be hardcoded into tool handlers.

### 17A.1 Skill Model

Stored in `cms_admin.skills`:
- `name` (unique), `version`, `description`
- `trigger_hints` — keywords / regex / semantic tags the matcher uses to select skills per call
- `system_prompt_body` — prepended to the base system prompt when the skill is engaged
- `tool_allowlist` — narrows the callable tool set when the skill is engaged (never widens past the caller's existing permissions)
- `examples` — optional few-shot examples
- `status` — `draft`, `awaiting_activation`, `active`, `disabled` (**site-wide** lifecycle)

### 17A.2 Two Levels of "Activation"

Terminology is precise because both levels exist:

| Level | Who decides | Scope | What it means |
|---|---|---|---|
| **Site-wide activation** | Human Owner (required) | The whole site | Skill moves from `awaiting_activation` to `active` and becomes eligible for engagement in any chat |
| **Per-chat engagement** | AI (auto) + user (manual toggle) | A single chat session | Skill is currently augmenting the AI's system prompt in this chat |

### 17A.3 Auto-Engagement

**AI automatically engages skills when contextually needed** — there is no need for the user to know which skill to pick. Examples:
- User says "create a new pricing page" → AI engages `compose-page`
- User says "why is this page slow?" → AI engages `explain-page`
- User asks to improve search rankings across pages → AI engages `seo-optimize` and `brand-voice-guard`

The matcher runs on every AI call against the site-active skill set, using `trigger_hints` + lightweight semantic scoring on the current user message + chat context. Top-K matches become *engaged*; their `system_prompt_body` is concatenated into the system prompt and the union of their `tool_allowlist` restricts tool availability. Engagements are tracked per chat session so the user can see why the AI is behaving a certain way.

### 17A.4 Manual Engagement / Disengagement

Every chat has an **Engaged Skills panel** showing:
- which skills the AI auto-engaged (with rationale: "matched trigger 'pricing page'")
- which skills the user manually engaged
- which skills the user manually disengaged in this chat

The user can:
- **Manually engage** any site-active skill — forces it on for this chat even if the matcher would not select it
- **Manually disengage** any skill the AI auto-engaged — takes precedence over the matcher for this chat
- **Pin defaults** at the user level (separate UI) so a chosen set always engages in new chats

Manual overrides persist for the life of that chat; a new chat starts with the default matcher behaviour again.

### 17A.5 AI Authorship + Human Gates

- AI can draft and update skills via the standard preview → snapshot → confirm path (like any other AI change)
- **Creating a new skill** additionally requires explicit human Owner site-wide activation — parallel to plugin activation
- **Behaviour-learned proposals:** a background job scans the audit log for repeated user-correction patterns (same rewrite applied 3+ times within N sessions) and emits a `skill_proposals` row. Proposals sit in an Owner review queue; nothing auto-applies

### 17A.6 Base Skills (shipped with core)

All arrive site-wide-active on first install. Each ships with its auto-engagement triggers.

So the AI is useful from day one without hand-authored prompt scaffolding:

- `compose-page` — prompt-first page creation; orchestrates module picks, copy writes, SEO auto-fill, and image requests
- `explain-page` — a11y / SEO / readability audit of any page, returning a structured report
- `brand-voice-guard` — hard-checks AI output against the per-site AI memory (§17.1a); rewrites or flags violations
- `seo-autofill` — fills SEO fields once before the first publish of a page (§11); never auto-overwrites afterwards
- `seo-optimize` — explicit cross-page SEO optimization; takes user-supplied context (e.g. keyword analysis) and `page_ids[]`, produces batched preview
- `summarize-plugin-data` — front-ends the `analyze_plugin_data` tool (§4) with redacted data flows
- `scoped-edit` — auto-engages when element reference chips are present in the chat composer; constrains the AI to act on the referenced elements only (single-click or multi-click selection)
- `import-site` — drives the site-import wizard (§15.6); scrapes an existing URL, proposes a module / typed-content structure, stages a site snapshot for review, uses screenshots for design-fidelity verification
- `site-memory-learner` — detects repeated user corrections / preferences and submits `site_ai_memory` proposals (§17.1a)

Extended built-in plugins (§14.9) each ship matching companion skills (`schedule-publish`, `apply-kit`, `model-content`, `analyse-traffic`).

---

## 18. Technology Stack

| Component | Decision | Status |
|---|---|---|
| Runtime | Bun | Decided |
| Admin Framework | SvelteKit + svelte-adapter-bun | Decided |
| Static Output | Astro + Bun | Decided |
| Plugin sandbox runtime | Deno (subprocess) | Decided |
| Plugin frontend | Web Components (native browser) | Decided |
| Plugin static analysis | oxc-parser with custom rule walker | Decided |
| Static + delta rendering | staticRender at deploy + Web Component delta fetch | Decided |
| Module versioning | Live references + site snapshots include module state | Decided |
| i18n URL strategy | Mixed subdirectory / subdomain / domain per locale — plugin-provided (§7.2) | Decided |
| i18n translation | AI two-mode (new / update with structured diff) — plugin-provided (§7.2) | Decided |
| hreflang | Head/sitemap contribution points; emitted by `international-site` (§7.1) | Decided |
| Missing translations | Clean 404 — no fallback (requirement on `international-site`, §7.2) | Decided |
| Redirect generation | Provider-appropriate file generated at deploy time | Decided |
| SEO fields | Structured fields per page, rendered at deploy | Decided |
| Sitemap / robots.txt | Auto-generated at deploy; language entries + hreflang via contribution points (§7.1) | Decided |
| Media storage | Provider-appropriate object storage via upload endpoint | Decided |
| Image optimization | Auto on upload (resize, compress, WebP) | Decided |
| Database | PostgreSQL — single instance, cms_admin + cms_public | Decided |
| Cloud DB HA (GCP) | Cloud SQL high availability | Decided |
| Cloud DB HA (AWS) | RDS Multi-AZ | Decided |
| Cloud DB HA (Azure) | Azure Database zone-redundant | Decided |
| Self-hosted DB backup | pgBackRest WAL streaming (default) | Decided |
| Self-hosted DB HA | Patroni (opt-in, documented) | Decided |
| Provisioning | Pulumi with TypeScript | Decided |
| Auth library | Arctic (OAuth2) | Decided |
| Auto-redeploy | Internal webhook with 10–15s debounce, optional toggle | Decided |
| Self-hosted AI (text) | Ollama / LM Studio via OpenAI-compatible adapter | Decided |
| Self-hosted AI (images) | LocalAI via OpenAI-compatible adapter | Decided |
| SSL/TLS | Let's Encrypt (self-hosted) / provider-native (cloud) | Decided |
| Input validation | Zod | Decided |
| Licence | MPL 2.0 (Mozilla Public License 2.0) | Decided |
| Database RLS | Per-table `ENABLE` + `FORCE ROW LEVEL SECURITY`, per-actor / per-plugin policies via session settings | Decided |
| Plugin frontend isolation | Shadow DOM mandatory on every Web Component | Decided |
| Plugin activation | Human Owner confirmation required; built-ins install one-click via signed manifests | Decided |
| Skills system | Claude-style skills with AI authorship + human activation; behaviour-learned proposal queue | Decided |
| Per-site AI memory | `site_ai_memory` Owner-curated snippets prepended to every AI call | Decided |
| Editor UX | Draft → Live in editor view; three-env model in Ops view | Decided |
| SEO auto-fill | Derived defaults + persisted overrides with reset-to-auto | Decided |
| URL strategy default | Subdirectory; subdomain/domain gated behind Advanced URL routing toggle | Decided |
| Testing | Vitest unit + Vitest-against-real-Postgres integration + Playwright E2E; one Playwright script per verification-table row | Decided |

---

## 19. Non-Functional Requirements

- **Security:** AI and plugin layers fully sandboxed — Deno subprocess, injected API client, oxc-parser validation, auth plugin locked from AI modification
- **Performance:** Static HTML first, delta fetches only, managed PostgreSQL with HA, image optimization on upload
- **SEO:** All content and plugin data pre-rendered as static HTML. Sitemap and robots.txt auto-generated; hreflang and language sitemap entries contributed by `international-site` (§7.1). Missing translations return clean 404 (§7.2)
- **Portability:** No lock-in to any cloud provider, database variant, or AI vendor
- **Ease of setup:** Single provisioning command, SSL auto-provisioned per domain, custom domains supported
- **Open Source:** Licensed under **MPL 2.0**. All dependencies must be MPL-2.0-compatible (MPL-2.0, Apache-2.0, MIT, BSD, ISC). GPL/AGPL/SSPL/proprietary dependencies are blockers. Community-friendly, modular codebase
- **Auditability:** All AI actions and database operations logged through single choke points
- **Reliability:** Staging always separate from production, auto-redeploy debounced, cloud deployments HA by default
- **Cost control:** Per-user AI token budgets and daily spend caps configurable in admin settings
- **i18n:** Language and country/language targeting, mixed URL strategies, AI-assisted translation with change tracking, no untranslated fallbacks — provided by the `international-site` plugin (§7)

---

*All architectural decisions resolved. Ready for technical specification and implementation planning.*