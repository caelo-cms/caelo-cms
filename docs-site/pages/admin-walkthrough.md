---
slug: admin
template: doc-page
locale: en
status: published
seo:
  title: Using the Caelo admin
  description: A tour of the admin app — live-edit, chat, security panel, deployments, plugins.
---

# Using the admin

After install, you log in at `https://your-install/login` and land on a dashboard. The admin is structured around a few high-level surfaces:

## Live-edit (`/edit`) — the flagship surface

This is where you spend most of your time. The page renders your real site in a chrome-less iframe with a floating chat overlay on top. You ask the AI to change something; it changes; you publish.

- **Page picker** in the toolbar — switch between pages
- **Chat overlay** — drag, pin to bottom / right, collapse. Per-user persisted layout.
- **Click-to-chat** — Opt+Ctrl+Cmd + click an element → a chip appears in the composer; the AI scopes its next edit to that element
- **Stage + Confirm publish** in the toolbar — two-step gate; you preview then confirm
- **Branch-aware** — every chat operates on its own preview branch; two editors don't collide

Read the deep dive: [`/admin-live-edit`](/admin-live-edit).

## Content (`/content/...`)

The structured surfaces for when the chat isn't the right tool:

- `/content/pages` — list, search, filter; bulk operations
- `/content/modules` — the module library
- `/content/templates` — page-type templates
- `/content/translations` — per-page × per-locale matrix; bulk-translate
- `/content/chat` — chat history (separate from `/edit`'s session list)
- `/content/snapshots` — Advanced History; per-module / per-site revert

## Security control panel (`/security/...`) — Owner only

The Owner-only controls. This is where you configure the AI provider, set budgets, manage plugins, mint MCP tokens, configure auth, manage users + roles + custom permissions, and run deployments.

Tiles:

- **AI provider** — `/security/ai` — pick + configure the active provider (Anthropic / OpenAI / Google / local OpenAI-compat)
- **Pricing** — `/security/ai/pricing` — per-model rates that drive cost calculation
- **Budgets** — `/security/ai/budgets` — six caps (3 scopes × 2 op-types) with status badges
- **Telemetry** — `/security/ai/telemetry` — opt-in toggles + payload preview
- **Costs** — `/security/costs` — five-panel dashboard (totals + budget status + per-day + per-attribution + roll-up)
- **MCP tokens** — `/security/mcp` — bearer tokens for `bunx @caelo-cms/mcp-server`
- **Plugins** — `/security/plugins` — Tier 1 + Tier 2 management, awaiting-activation queue
- **Locales** — `/security/locales` — language registry + URL strategies (admin-only; AI rejected)
- **Email** — `/security/email` — Resend / SMTP / SES selection
- **Gateway** — `/security/gateway` — rate limits, captcha, body cap, request log
- **Users + roles** — `/security/users` + `/security/roles`
- **Skills** — `/security/skills` — AI behaviour bodies, AI-proposed queue
- **Subagents** — `/security/subagents` — observability for spawn_subagent runs
- **Deployments** — `/security/deployments` — Ops view with promote / rollback
- **DNS** — `/security/dns` — records the active Pulumi stack expects

## Where the AI lives

Two surfaces:

1. **The live-edit chat overlay** — for editing pages (the primary surface)
2. **The standalone chat at `/content/chat`** — for everything else (translation jobs, plugin moderation, drafting kits)

A third surface — **MCP** — exposes the same chat-runner outside the browser. See [`/mcp`](/mcp).

## What the AI can't do

Per `CLAUDE.md` §2 invariants:

- Can't write raw HTML to a page (only modules can be raw HTML, and those are versioned)
- Can't publish a page without your click
- Can't activate a plugin without your click (Tier 1 ships signed; Tier 2 needs Owner approve)
- Can't change locale config (admin-only at the validator)
- Can't trigger a deploy past staging without an Ops-role human
- Can't bypass the snapshot system; every write is reversible

You'll see these as `ActorScopeRejected` errors when the AI attempts them — the AI surfaces a "click here to do this yourself" message in the chat.

## Next

- [Live-edit overlay →](/admin-live-edit)
- [Build a plugin →](/plugins-build)
- [MCP server →](/mcp)
