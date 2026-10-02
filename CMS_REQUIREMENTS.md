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

Caelo is a **plugin host**. Almost every feature beyond the irreducible kernel — translation, SEO, media, scheduled publish, comments, forms, kits, typed content, analytics, even authentication — is a plugin built against the same SDK. The kernel is small on purpose: auth state machine, RLS, the Query API chokepoint, the snapshot system, the chat-runner, the deploy trigger, the plugin host itself.

There is **no external plugin marketplace**. A plugin either ships with a Caelo release (`packages/plugins/<slug>/`) or is installed at runtime — written by the AI or pasted by an Owner — with its source stored in `plugins.source_code`.

### 14.2 One plugin model — who wrote it grants nothing

Every plugin is the same kind of thing, whoever wrote it and however it arrived. **Authorship and delivery path never determine what a plugin may do.** Most code — shipped plugins included — is AI-written; a distinction by author would be a formality, not a security boundary.

- **Provenance is evidence, not permission.** A shipped plugin's release signature proves which artifact is installed and that it came with a Caelo release. It is shown to the Owner at approval time. It does not unlock a single capability.
- **Everything beyond the base (§14.4) is an explicit Owner grant (§14.5)**, bound to the exact artifact (content digest). A new version of the plugin is a new artifact and needs a new approval; a revoked grant takes effect before the next operation.
- **The rules in this chapter bind every plugin identically.** A shipped plugin may not do anything a runtime-installed plugin with the same grants could not.

### 14.3 Execution

- **Target: one sandbox for all plugins.** Plugin backend code runs in a Deno subprocess with `--no-read --no-write --no-net --no-env --no-prompt --no-npm --no-remote`, bounded time and memory, talking to the host only through a validated broker (every call Zod-checked, authorization re-checked per call). Shipped plugins run there too; running in-process is an optimisation that must never widen what a plugin can do.
- **Bundling happens in the host and must itself be closed:** the bundler resolves only the plugin's own entry and the SDK packages; any other import or `require` fails.
- **The validator (§14.9) runs for every plugin** before it is loaded.
- **The frontend** runs in the visitor's browser as Web Components (§14.10) regardless of where the backend runs.

### 14.4 Base capabilities — no grant needed

Every active plugin gets exactly this:

- **Its own public tables** (`cms_public.<slug>`), declared in the manifest schema, read and written through `ctx.query`. RLS scopes every row to the plugin; no other plugin and no visitor query can reach them.
- `ctx.theme` (read-only tokens), `ctx.visitor` (opaque visitor id, public user id, IP hash — **never** the session bearer token), `ctx.captcha` (proof verification), `ctx.api` (the plugin's own public read surface), `ctx.invocation` (who the call acts for — origin, actor, the chat's human, the chat branch).
- Declaring `operations`, a Web Component, and `staticRender`.
- **Visitor-facing operations** listed in `publicOperations` (default deny; §14.7).

### 14.5 Grants — Owner-approved, per artifact

A plugin requests grants in its manifest; the Owner approves them at activation, seeing for each grant what it allows. Grants are recorded as receipts bound to the artifact digest and are re-checked on every broker call. Every grant is brokered by the host; a plugin never receives a credential, connection or raw handle.

| Grant | Allows | Constraints |
|---|---|---|
| Private plugin storage | Tables in the plugin's own private schema in `cms_admin` (author-side data a visitor must never read) | Own schema only; authoring writes follow §14.7 |
| Core data — per domain, read | Named Query API **read** operations of one domain (e.g. media: `media.list`, `media.get`) | Never a table, never SQL; one grant per domain |
| Core data — per domain, write | Named Query API **write** operations of one domain | Same path as any human/AI write: validator, audit, snapshot, chat branch (§14.7) |
| Chat tools | The plugin's operations offered to the AI as tools | The Owner sees every tool name and description in readable form; descriptions are length-limited and part of the approved artifact |
| Companion skills | Skills that ship with the plugin, live with it, archive with it | Shown readably at approval; part of the artifact |
| AI provider / image generation | Model calls brokered by the host | Budgeted and metered; the plugin never sees a key |
| Background workers | Scheduled or queued work | Scheduled and run by the host; same capability set as the plugin's operations |
| Email | Sending mail through the configured transport | Rate-limited; no transport credentials |
| Private files | Immutable author-side files | Own files only; size quotas |
| Client assets | A site-wide browser runtime on every page (§14.10) | Widest blast radius of any grant; shown as such at approval |
| Contributions (head, sitemap, URL slots, data lists, domain events, deferrals) | Structured contributions core validates and renders | Never raw HTML into `<head>`; URL-shape changes are §11.A-gated (CLAUDE.md) |

Hard-to-revert actions a plugin performs (e.g. a URL-strategy change) additionally go through the in-chat approval gate of CLAUDE.md §11.A, per call.

### 14.6 Data zones

1. **The plugin's own data** — its public tables (§14.4) and, with the grant, its private storage and files. Only this plugin reaches them.
2. **Core data** (pages, modules, content, media, themes, layouts, …) — **never directly**. Only through the named Query API operations of a granted domain, with the same validation, audit, snapshots and branch rules as every other writer.
3. **Another plugin's data** — never.

### 14.7 Writes never go straight to live

- **No plugin writes the live state of `cms_admin` directly.** Authoring writes — core data and the plugin's own private storage alike — go through named operations that validate, audit and snapshot. A write that originates in a chat lands on that chat's branch, is undoable with the chat, and reaches live only when the branch is published.
- **The one live exception** is a visitor write into the plugin's own public tables (a form submission, a comment, a rating) through a declared `publicOperation`. Those are runtime data, not authoring, and follow CLAUDE.md §7 (CAPTCHA/PoW, rate limit, honeypot).
- **No raw SQL** — not in plugin code, and not in the host code that brokers for plugins. Every database access is a named operation behind the Validator.
- **Approved actions apply live — for someone who could publish them.** A gated plugin tool (§11.A) runs after the click as the human who approved. If that person may publish (`deploy.trigger`), the click is the publishing decision and the action applies on main; otherwise it stays on the chat's branch and goes live when the chat is published. Owner-panel and worker writes go to main, audited and snapshotted.
- **Derived URLs follow the branch.** A page a chat creates composes its `current_path` from that chat's plugin rows (e.g. a locale prefix); a main page keeps its live URL until publish, when the merge recomposes main paths and 301s every page that moved.
- **Render and visitor calls never write private storage.** They are not authoring contexts. Create-time defaults (a settings row, seed categories) are written by the plugin's `onActivate` hook, which runs on main whenever the host brings the plugin up; read paths never seed.

### 14.8 Activation and lifecycle

- **Activation is a hard state for every plugin.** Until an Owner activates it, nothing of the plugin is loaded (see CLAUDE.md §2). Shipped plugins are no exception.
- **Lifecycle:** `draft` → `validated` → `awaiting_activation` → `active` / `disabled`. The AI may submit and propose; only a human Owner activates and grants.
- **Updates** (a new Caelo release shipping a new plugin version, or a new runtime submission) produce a new artifact; its grants are re-approved before it runs. Disabling never drops data.

### 14.9 Validation — oxc-parser

A validator built on oxc-parser runs for every plugin before load and rejects, with a structured error the AI can act on: imports other than the SDK, `require` in any spelling, `import.meta`, dynamic `import()`, `fetch`/`XMLHttpRequest`/`WebSocket`, `Deno.*`, raw SQL strings, `eval`/`new Function`, and top-level `globalThis` writes.

### 14.10 Plugin Frontend — Web Components

- Native browser Web Components — no framework dependency.
- **Shadow DOM is mandatory** on every plugin Web Component. Open mode by default, closed mode configurable per plugin.
- Theme tokens injected as CSS custom properties on the shadow root; the API client is injected by the SDK and cannot construct arbitrary HTTP calls.

#### Client assets — the site-wide runtime channel (#449)

With the client-assets grant, a plugin declares `buildAssets`, returning `.js` / `.css` files **once per build**; the generator writes them under `_caelo/plugin/<slug>/` with the content hash in the name and references them from every page.

- **Once per build, not per page.** The runtime can bake its configuration in; a static site cannot afford a blocking fetch.
- **Content hash in the filename** — long CDN TTL and immediate change landing both hold.
- **One resolver, two surfaces.** The deploy links the files; the admin preview inlines the identical bytes.
- **Loud, per CLAUDE.md §2.** A throwing plugin, a malformed file name and an over-budget payload fail the build.

#### Deferred modules — withholding content until a plugin allows it (#450)

A plugin with the deferrals contribution declares `deferralsOperation`, receives every module of the render pass **with the content about to ship**, and returns a verdict per withheld module (`reason`, `placeholderModuleSlug`, optional `defaultPlaceholder`). Core emits:

```html
<div data-caelo-deferred="<plugin>" data-reason="<key>" data-module="<slug>">
  <div data-caelo-deferred-placeholder>…placeholder…</div>
  <template data-caelo-deferred-content>…the real module, its CSS and JS…</template>
</div>
```

- **`<template>` is the mechanism.** Nothing inside it is fetched. The module's CSS and JS travel inside the template too; the plugin's client runtime runs the JS once, after cloning the markup in.
- **Only what loads with the page counts.** A gate judges page-load requests (embeds, images, stylesheets, fonts, scripts); a link contacts nobody until clicked.
- **Per module, not per placement**, including modules placed in a layout.
- **The placeholder is an ordinary module** by slug; while the site has none, the plugin's `defaultPlaceholder` renders instead, so a page never fails because a placeholder was not designed yet. Without either, the render fails loudly.
- **Generic by design** — core learns "withheld by plugin X for reason Y", nothing about consent.

### 14.11 Shipped plugins

Shipped with the release under `packages/plugins/<slug>/`, subject to every rule above:

- **`international-site`** — the i18n feature of §7; locale-config writes are §11.A-gated.
- **`consent-manager`** — consent categories, tag manager, deferred embeds, proof of consent.
- **`comments`**, **`forms`**, **`newsletter`**, **`ratings`** — visitor features.
- **`auth`** — pre-built, hardened. **AI cannot regenerate core logic.** OAuth2 providers added via config entries + secrets.
- Planned on the same model: `seo`, `media`, `scheduled-publish`, `kits`, `typed-content`, `edge-analytics`.

Each ships companion skills as its natural-language entry point.

### 14.12 Source location and upgrade path

- **Shipped:** `packages/plugins/<slug>/` — `package.json` (`@caelo-cms/plugin-<slug>`, MPL-2.0, depends on `@caelo-cms/plugin-sdk`), `src/index.ts` (`definePlugin`), a signed `manifest.json`. A Caelo upgrade that changes a shipped plugin produces a new artifact whose grants are re-approved (§14.8).
- **Runtime-installed:** `plugins.source_code`, submitted via `submit_plugin` (AI) or the Owner panel.
- **Schema changes** apply transactionally when the new artifact is activated; failure keeps the previous version active and surfaces the error in `/security/plugins`.

### 14.13 Implementation status

The model above is normative. Where the code does not meet it yet, this list is the source of truth, and each item is a tracked defect, not an accepted exception:

- **Shipped plugins' chat tools still write their public tables live** (e.g. comment moderation from a chat). Installed plugins are refused that from a chat branch; public tables have no branch.
- **Runtime-installed plugins can be granted only private storage, private files, image generation, chat tools and companion skills so far.** Their grants are Owner receipts per artifact digest (`plugin_capability_grants`), checked inside every private-storage and private-file operation and every skill lookup; the other grants of §14.5 have no broker for them yet, and a plugin requesting one does not activate.
- **Shipped plugins run in-process and receive their capabilities at load** rather than through Owner-approved, per-artifact grants; `cms_admin` is a broad capability rather than per-domain read/write grants.
- **A render call's `ctx.cms.call` is not refused for core writes.** Private storage refuses render and visitor writes; core operations carry no read/write marker the host could check.
- **Host code still issues SQL directly** for plugin domain-event polling, AI cost accounting, the per-operation audit row and plugin registration in the loader. Plugin table storage itself goes through the `plugin_storage.*` / `plugin_public_storage.*` operations, which follow the branch model: chat writes land on the chat's branch with a `pluginRow` lock, Stage/publish applies them live, `chat.discard_branch` drops them, and main-line writes are snapshotted.

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
- Experiment results (per-variant conversion / engagement events) flow via the edge-log analytics plugin (§14.11)
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
- AI cannot grant a plugin any capability — grants are human Owner approvals bound to the exact plugin artifact (§14.5); the AI may only request them
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

Extended built-in plugins (§14.11) each ship matching companion skills (`schedule-publish`, `apply-kit`, `model-content`, `analyse-traffic`).

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