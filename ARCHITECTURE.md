# Architecture

This is the deep-dive companion to [`CLAUDE.md`](./CLAUDE.md). CLAUDE.md is the engineering-rules file (read first, kept short). This file answers *"how does Caelo fit together?"* — broken into four focused diagrams plus a guide to where things live in the repo.

For the *why* behind every choice (RLS, two databases, snapshots, no-fallbacks, etc.) see [`CMS_REQUIREMENTS.md`](./CMS_REQUIREMENTS.md).

---

## 1. System overview — what runs where

```mermaid
graph TD
  subgraph edge["Edge"]
    Caddy["Caddy proxy<br/>:8081 staging · :8082 production"]
  end

  subgraph apps["apps/"]
    Admin["apps/admin<br/>SvelteKit + svelte-adapter-bun<br/>authoring UI · /edit · /security · API"]
    StaticGen["apps/static-generator<br/>subprocess invoked at deploy<br/>emits HTML to output/&lt;env&gt;/"]
    Gateway["apps/api-gateway<br/>P12+ · public plugin writes<br/>cms_public role only"]
  end

  subgraph pkgs["packages/"]
    AdminCore["packages/admin-core<br/>ops registry · AI tools · chat-runner<br/>audit · snapshot emitter"]
    QueryApi["packages/query-api<br/>defineOperation · Validator · Adapter<br/>the chokepoint"]
    Shared["packages/shared<br/>Zod schemas · two-pass composer<br/>structured-sets validators"]
    Migrations["packages/migrations<br/>SQL migrations · drizzle-kit"]
    Provisioning["packages/provisioning<br/>Pulumi (P14+)<br/>self-hosted · GCP/AWS/Azure"]
    PluginSdk["packages/plugin-sdk<br/>P11+ · definePlugin · sandbox SDK"]
  end

  subgraph dbs["Databases · FORCE RLS on every table"]
    CmsAdmin[("cms_admin<br/>admin_role<br/>authoring · pages · modules<br/>snapshots · chat · audit")]
    CmsPublic[("cms_public<br/>public_role · INSERT-only<br/>plugin data · visitor sessions")]
  end

  Caddy --> Admin
  Caddy --> Gateway
  Caddy -. serves built HTML .-> StaticGen

  Admin --> AdminCore
  AdminCore --> QueryApi
  AdminCore --> Shared
  Gateway --> QueryApi
  StaticGen --> AdminCore
  StaticGen --> Shared

  QueryApi -- admin_role --> CmsAdmin
  QueryApi -- public_role --> CmsPublic

  Migrations -. apply on boot .-> CmsAdmin
  Migrations -. apply on boot .-> CmsPublic

  Provisioning -. provisions .-> Caddy
  Provisioning -. provisions .-> CmsAdmin
  Provisioning -. provisions .-> CmsPublic
```

**Key invariants** (see [CLAUDE.md §2](./CLAUDE.md#2-non-negotiable-invariants)):

- `admin_role` and `public_role` are isolated. The API Gateway never holds `admin_role` credentials.
- RLS is `FORCE`d on every table in both databases — role isolation alone is not enough.
- The static generator runs as a subprocess at deploy time. It is not a long-running service.

---

## 2. Content composition — how a page becomes HTML

Four primitives wired top-down. A **layout** owns site-wide chrome; a **template** defines a page-type's blocks; a **page** binds to one template and references modules; **modules** are the leaf content units. Composition is two-pass: template fills first, then the layout wraps it.

```mermaid
flowchart LR
  subgraph primitives["Content primitives"]
    Layout["LAYOUT<br/>site-wide chrome<br/>html with named &lt;caelo-slot&gt;<br/>blocks: header · content · footer"]
    Template["TEMPLATE<br/>page-type structure<br/>fills layout's `content` slot<br/>blocks: hero · body · sidebar · …"]
    Page["PAGE<br/>the URL surface<br/>slug · locale · title · status"]
    Module["MODULE<br/>html + css + js<br/>live-referenced · reused"]
  end

  Template -->|templates.layout_id| Layout
  Page -->|pages.template_id| Template

  subgraph attachments["Module attachment rows"]
    PageModules["page_modules<br/>(page, block, position) → module<br/>per-page slot fills"]
    LayoutModules["layout_modules<br/>(layout, block, position) → module<br/>site-wide slot fills"]
  end

  Page --> PageModules
  Layout --> LayoutModules
  PageModules -->|module_id| Module
  LayoutModules -->|module_id| Module

  subgraph composer["Two-pass composer · packages/shared/preview-compose.ts"]
    Pass1["pass 1<br/>applySlotReplacements(template.html, page_modules)<br/>→ inner body"]
    Pass2["pass 2<br/>applySlotReplacements(layout.html,<br/>{ content: inner, header / footer / nav: layout_modules })"]
    Pass1 --> Pass2
  end

  Page -. composed by .-> Pass1
  Layout -. composed by .-> Pass2

  subgraph sideband["Sideband · structured_sets"]
    NavMenu["kind=nav-menu<br/>renders into modules slug 'nav-menu-*'"]
    Theme["kind=theme<br/>emits :root{--token:value} into &lt;head&gt;"]
    Tags["kind=taxonomy / tags / link-list<br/>future plugins"]
  end

  Pass2 -. injects at render .-> NavMenu
  Pass2 -. injects at render .-> Theme

  Pass2 --> Output["composed HTML<br/>used by /edit preview AND apps/static-generator"]

  SiteDefaults[("site_defaults<br/>singleton row<br/>default_layout_id · default_template_id")]
  SiteDefaults -. consulted at create-time only .-> Page
  SiteDefaults -. consulted at create-time only .-> Template
```

**No-fallback rule** (see [CLAUDE.md §2](./CLAUDE.md#2-non-negotiable-invariants)): missing layout `content` slot, missing structured set referenced by name, missing template/layout where required → `ComposeError` / structured `HandlerError`. Never silent recovery. `site_defaults` is a *create-time* resolver, NOT a render-time fallback.

**Three "add module" paths, picked by intent:**

| user says… | tool | blast radius |
|---|---|---|
| "add a CTA on this page" | `add_module_to_page` | one page |
| "add a hero on every blog post" | `add_module_to_template` | all pages on the template |
| "add a footer on every page" | `add_module_to_layout` | all pages on the layout |
| "move the hero to the header" | `move_module` | same page, cross-block |
| "show testimonials before gallery" | `reorder_module` | same page, same block |
| "duplicate this page" | `duplicate_page` | modules carry by reference |
| "switch this page to landing-tpl" | `change_template` | modules migrate; orphan disposition required |
| "edit the menu" | `set_nav_menu` | `structured_sets` kind=nav-menu |
| "make the primary brighter" | `update_theme` | `structured_sets` kind=theme |

Mutations on layouts and site_defaults are Owner-only (`actorScope: ["human","system"]`); AI calls return `ActorScopeRejected` and the chat surfaces a permission message instead of retrying.

---

## 3. Write path — from user click to Postgres row

Every mutation — form action, AI tool call, deploy trigger — traverses the same chain. The Validator is the chokepoint; the adapter binds the actor identity to the transaction so RLS policies see the right scope.

```mermaid
graph TD
  Click["user click /<br/>AI tool call /<br/>deploy trigger"] --> Op{"defineOperation<br/>registry lookup"}
  Op -->|name unknown| Reject1["fail: UnknownOperation"]
  Op -->|known| ActorCheck["actor scope check<br/>actorScope: human / ai / system"]
  ActorCheck -->|out of scope| Reject2["fail: ActorScopeRejected<br/>chat surfaces 'ask Owner'"]
  ActorCheck -->|in scope| Validate["Zod Validator<br/>shape · types · enum membership"]
  Validate -->|invalid| Reject3["fail: ValidationError<br/>structured field paths"]
  Validate -->|valid| Begin["Adapter opens transaction<br/>BEGIN"]
  Begin --> SetActor["set_config('caelo.actor_id', …, true)<br/>set_config('caelo.actor_kind', …, true)<br/>(local to this tx → drives RLS)"]
  SetActor --> Branch{"chat-branch<br/>aware?"}
  Branch -->|yes| BranchSet["set_config('caelo.chat_branch_id', …)<br/>writes tagged with chat_branches.id"]
  Branch -->|no| Handler["handler runs<br/>SQL via Drizzle / Bun SQL"]
  BranchSet --> Handler
  Handler --> Audit["recordAudit(tx, op, actor, ok, inputHash)<br/>same transaction"]
  Audit --> Snapshot["emitSnapshot(tx, entity, opKind)<br/>page · module · template · pageLayout snapshots<br/>same transaction"]
  Snapshot --> Commit["COMMIT"]
  Commit --> Result["Result&lt;T, E&gt;<br/>returned to caller"]

  Handler -.->|throws| Rollback["ROLLBACK<br/>audit + snapshot rolled back atomically"]
```

**Branch-aware writes.** Each chat session owns an ephemeral `chat_branches` row. Snapshots emitted from a chat are tagged with that `chat_branch_id`. The branch only merges into main on publish (`publishChatSessionOp`). This is why two editors in two chats can edit the same page without colliding.

**Static-generator parity.** Both the admin's `/edit` preview AND `apps/static-generator` (deploy) call `composePageWithLayout` from `packages/shared/preview-compose.ts`. Same input → byte-identical output. There is no separate "production renderer".

---

## 4. Data model — what's in `cms_admin`

Foreign keys are shown only where they cross domain boundaries. Every box has FORCE RLS.

```mermaid
erDiagram
  %% Auth
  users ||--o{ user_roles : "has"
  roles ||--o{ user_roles : "has"
  roles ||--o{ role_permissions : "has"
  permissions ||--o{ role_permissions : "has"
  users ||--o{ sessions : "has"
  actors ||--o{ users : "is"

  %% Content
  layouts ||--o{ layout_blocks : "declares"
  layouts ||--o{ layout_modules : "fills"
  templates ||--o{ template_blocks : "declares"
  pages ||--o{ page_modules : "fills"
  templates }o--|| layouts : "templates.layout_id"
  pages }o--|| templates : "pages.template_id"
  page_modules }o--|| modules : "module_id"
  layout_modules }o--|| modules : "module_id"
  site_defaults }o--|| layouts : "default_layout_id"
  site_defaults }o--|| templates : "default_template_id"

  %% Snapshots
  site_snapshots ||--o{ page_snapshots : "groups"
  site_snapshots ||--o{ module_snapshots : "groups"
  site_snapshots ||--o{ template_snapshots : "groups"
  site_snapshots ||--o{ page_layout_snapshots : "groups"
  site_snapshots ||--o{ theme_snapshots : "groups"
  chat_branches ||--o{ chat_branch_publish_marks : "merged via"

  %% Themes (v0.11.0, #45)
  themes ||--o{ theme_pending_actions : "gated via"
  themes }o--o| media_assets : "logo / favicon / social-share FKs"

  %% Chat
  chat_sessions ||--o{ chat_messages : "has"
  chat_sessions ||--o{ ai_calls : "spawns"
  chat_sessions }o--o| pages : "chat_sessions.page_id (nullable)"
  chat_sessions }o--o| templates : "chat_sessions.template_id (nullable)"
  chat_sessions }o--|| chat_branches : "chat_branch_id"
  site_ai_memory ||--o{ site_memory_proposals : "proposed via"

  %% Deploy
  deploy_targets ||--o{ deploy_runs : "has"

  %% Sideband
  structured_sets ||--o{ pages : "rewritten on slug change"
  redirects }o--o| pages : "from_path"
  audit_events }o--|| actors : "by"
  rate_limit_buckets ||--|| actors : "scoped"
```

**Domain boundaries.**

| Domain | Tables (representative) | Notes |
|---|---|---|
| **Auth** | `users`, `sessions`, `actors`, `roles`, `permissions`, `user_roles`, `role_permissions` | Argon2id passwords. Sessions hold a CSRF token consumed by every form action. |
| **Content** | `layouts`, `layout_blocks`, `layout_modules`, `templates`, `template_blocks`, `pages`, `page_modules`, `modules` | Two-pass composer: layout wraps template; both have block/module attachment rows. |
| **Snapshots** | `site_snapshots`, `page_snapshots`, `module_snapshots`, `template_snapshots`, `page_layout_snapshots`, `chat_branch_publish_marks` | Every write emits a snapshot. Reverting `site_snapshots` restores the full set atomically. |
| **Chat** | `chat_sessions`, `chat_branches`, `chat_messages`, `ai_calls`, `site_ai_memory`, `site_memory_proposals` | Sessions on ephemeral branches. AI memory proposals queue for Owner review. |
| **Deploy** | `deploy_targets`, `deploy_runs` | `deploy_runs.progress jsonb` updated by the static generator subprocess. |
| **Sideband** | `structured_sets`, `redirects`, `site_defaults`, `audit_events`, `rate_limit_buckets`, `user_preferences` | `structured_sets` is the typed-list primitive (nav-menus, taxonomies, tags, link-lists, language-selectors). `site_defaults` is a singleton row. |
| **Themes** (v0.11.0, #45) | `themes`, `theme_snapshots`, `theme_pending_actions` | DTCG-shaped jsonb `tokens` (color / dimension / typography composite / shadow composite / motion / breakpoint, plus DTCG aliasing). Exactly one `is_active=true` row enforced by partial unique index. Four media FKs for logo / logo-dark / favicon / social-share. Create / activate / delete go through the §11.A propose/execute gate (`theme_pending_actions`). The renderer reads the active theme via `ComposeInput.theme` and emits Tailwind 4-namespaced CSS vars under `<style data-source="theme">`. Zod source of truth: `packages/shared/src/themes.ts`. |

**Snapshot semantics.** A snapshot is a content-addressed copy of an entity at a point in time, grouped under a `site_snapshots` row tagged with the originating chat branch (or `NULL` for system / direct-admin writes). Reverting walks the group and restores every member in one transaction. Chat-keyed Undo (the primary history surface) targets the most recent `site_snapshots` row tagged with the active branch.

---

## Repo guide — where things live

| Path | What lives here |
|---|---|
| `apps/admin/` | SvelteKit admin app + every authenticated route (`/edit`, `/content/*`, `/security/*`). |
| `apps/static-generator/` | Subprocess invoked by `deploy.trigger`; reads composed pages + emits HTML to `output/<env>/`. |
| `apps/api-gateway/` | Reserved for P12+ — public plugin write endpoints under the `cms_public` role. |
| `packages/admin-core/` | Ops registry + AI tool dispatch + chat-runner + audit + snapshot emitter. The orchestrator. |
| `packages/query-api/` | `defineOperation`, the Validator, the Database Adapter. Every DB call goes through here. |
| `packages/shared/` | Zod schemas, the two-pass composer, the slot scanner, structured-sets validators. Shared between admin and static-gen. |
| `packages/migrations/` | SQL migrations for both `cms_admin` and `cms_public`; applied in order at boot. |
| `packages/plugin-sdk/` | P11+ — `definePlugin`, `defineComponent`, the Deno-sandbox SDK injected into plugin code. |
| `packages/provisioning/` | P14+ — Pulumi for self-hosted Compose, GCP, AWS, Azure adapters. |

---

*This document is hand-edited. A future `apps/admin/scripts/generate-architecture-doc.ts` could regenerate the diagrams from the ops registry + migration files; see the deferred items in the master plan.*
