---
slug: architecture
template: doc-page
status: published
seo:
  title: Architecture — Caelo CMS
  description: Layered permission model, two-database split, Query API chokepoint, snapshot system, one plugin model with Owner-approved grants. The deep architecture overview.
---

# Architecture

This page is the public version of `ARCHITECTURE.md` from the source repo — the same content, lightly rewritten for readers who haven't checked out the source yet.

## The four anchors

1. **Layered permission model** — Module / Template / Page / Layout / Content / SEO / Redirect / Plugin / Skill / Media / Security / Deployment (i18n is plugin-provided since the plugin-system-v2 cleanup). Each layer constrains what the AI can do without your click.
2. **Two-database split** — `cms_admin` (authoring) + `cms_public` (visitor + plugin data) with two isolated Postgres roles. **Row-Level Security forced on every table both ways.**
3. **Module / snapshot architecture** — pages assemble modules by *live reference*, not by raw HTML. Every Query API write emits a snapshot. Reverting one click in chat restores the page.
4. **One plugin model** — every plugin, shipped or AI-built at runtime, gets the same base (its own `cms_public.<slug>` tables) and everything else only as an Owner-approved grant bound to its exact version. Core data is reachable only through named Query API operations of a granted domain, and no plugin writes live directly. Plugin backends run in a Deno subprocess with no file, network or environment access ([Plugin permissions](/plugins-permissions)).

## What runs where

```
Caddy (TLS, edge)
  ↓
Admin app (apps/admin, SvelteKit + Bun)        ← human Owner / Editor / Reviewer
  ↓
Query API (packages/query-api)                  ← every write goes through here
  ├ Validator (Zod, actor-scope, no raw SQL)
  └ Database Adapter (RLS session vars)
  ↓
Postgres
  ├ cms_admin (admin_role)                      ← pages, modules, snapshots, audit
  └ cms_public (public_role + per-plugin scope) ← plugin data, visitor sessions

Plugin host (packages/plugin-host)              ← loads active plugins, brokers grants
  ├ shipped plugins (packages/plugins/<slug>)   ← forms, comments, consent-manager, ...
  └ runtime-installed plugins (Deno sandbox)    ← built by the AI or pasted by an Owner

Static generator (apps/static-generator)        ← runs at deploy; emits dist/
API gateway (apps/api-gateway)                  ← public visitor writes; cms_public role
MCP server (packages/mcp-server)                ← talk to your install from any IDE
```

## How a page becomes HTML

Four content primitives, composed by reference:

```
layouts (the site shell — <html><head><body><caelo-slot name="content">…)
  ↑ template.layout_id (every template binds to one layout)
templates (the page-type structure — fills the layout's content slot)
  ↑ pages.template_id
pages
  ↓ page_modules (per-page module attachments to template blocks)
  ↓ layout_modules (per-LAYOUT module attachments — header, footer, nav)
```

**No raw HTML on a page.** The Query API rejects writes that try. Modules are HTML+CSS+JS; pages reference modules by id; templates declare named blocks; layouts wrap everything.

## Write path

Every mutation traverses the same chain:

1. **Form action / chat tool call** dispatches a named operation
2. **Validator** rejects bad shape (Zod) + bad actor scope (`ActorScopeRejected`)
3. **Database Adapter** opens a transaction, sets `caelo.actor_id` / `caelo.actor_kind` / `caelo.plugin_id` for RLS
4. **Handler** runs against the transaction
5. **`recordAudit` + `emitSnapshot`** fire inside the same transaction
6. Commit

Branch-aware writes via chat sessions: each chat operates on its own preview branch of the snapshot tree; merges into main only on publish.

## Skills, subagents, MCP

- **Skills** — Claude-style behaviour bodies the AI engages per turn. Owner-curated, AI-proposable. Two-level activation: site-wide (Owner-required) + per-chat engagement (auto-matcher + manual override).
- **Subagents** — the AI spawns parallel reasoning loops (QA / brand-voice / legal-check) on demand. Each subagent runs the same `runChatTurn` code path with parent attribution.
- **MCP server** — exposes the chat-runner as a single `caelo_chat` tool. Same auth surface, same RLS, same audit trail as the browser chat.

## Provisioning

`bunx @caelo-cms/provisioning --provider <self-hosted|gcp|aws|azure>` runs Pulumi to spin up the platform-appropriate stack. Three environments per stack (dev / staging / production). Staging is `noindex` by default. The CMS doesn't manage its own DNS — `/security/dns` surfaces the records you need to create at your registrar.

## What's NOT in here

- **A plugin marketplace.** Out of scope per spec — plugins are AI-authored or shipped with core; the Owner UI is the only surface.
- **A WYSIWYG block editor.** The chat IS the editor. The live-edit overlay is the visual surface.
- **A multi-site / multi-tenant mode.** One install = one site. Run multiple installs if you need multiple sites.
- **A roadmap of "coming soon" features.** What's documented works.

## Deep dive

The canonical product spec is in [`CMS_REQUIREMENTS.md`](https://github.com/caelo-cms/caelo-cms/blob/main/CMS_REQUIREMENTS.md). Engineering principles are in [`CLAUDE.md`](https://github.com/caelo-cms/caelo-cms/blob/main/CLAUDE.md). Implementation history is in [`plans/MASTER_PLAN.md`](https://github.com/caelo-cms/caelo-cms/blob/main/plans/MASTER_PLAN.md).
