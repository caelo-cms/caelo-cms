---
slug: admin
template: doc-page
status: published
seo:
  title: Using the Caelo admin
  description: A tour of the admin app — live-edit, chat, settings, deployments, plugins.
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
- `/content/chat` — chat history (separate from `/edit`'s session list)
- `/content/snapshots` — Advanced History; per-module / per-site revert

### Page structure and URLs

Pages can sit under other pages. A page's URL is its parent's URL plus its own slug, so an
"Alerts" page under "SEO Monitoring" lives at `/seo-monitoring/alerts` (and a language plugin
adds its prefix on top, e.g. `/de/seo-monitoring/alerts`). Pages nest up to six levels; the
homepage stays at `/` and has no parent or child pages.

- In chat, just say where a page belongs — *"put Alerts under SEO Monitoring"*, *"make the
  pricing page top-level again"*. Moves of ten or more URLs at once ask for one click of
  approval in the chat first.
- In `/content/pages` the list shows the tree; a page's **Location** card moves it under
  another page (optionally with a new slug).
- Moving or renaming a page moves every page below it. Each old URL gets a permanent
  redirect, and links in menus, modules and content are updated to the new URLs.
- Two pages can share a slug as long as their URLs differ (`/monitoring/alerts` and
  `/rankings/alerts`). A move onto a URL that is already taken is refused — pick a new slug
  in the same step.
- A page with child pages cannot be deleted until you decide what happens to them: move them
  first, move them up to the deleted page's parent, or delete the whole section.

## Settings (`/settings/...`) — Owner only

The Owner-only controls. This is where you configure the AI provider, set budgets, manage plugins, mint MCP tokens, configure auth, manage users + roles + custom permissions, and run deployments.

Tiles:

- **AI provider** — `/settings/ai` — pick + configure the active provider (Anthropic / OpenAI / Google / local OpenAI-compat). Each catalogued provider also has a **Translation model**: by default page translations run on the chat model; pick a smaller model from the provider's catalogue to make them cheaper. The chat keeps its own model. Ask the AI and it proposes the change (`propose_set_translation_model`) for your approval.
- **Pricing** — `/settings/ai/pricing` — per-model rates that drive cost calculation. The AI can also propose rates (`propose_set_ai_pricing`), e.g. for a model it finds unpriced; you approve the card in the chat.
- **Budgets** — `/settings/ai/budgets` — six caps (3 scopes × 2 op-types) with status badges. Ask the AI to change a cap and it proposes it (`propose_set_ai_budget`) for your approval.
- **Telemetry** — `/settings/ai/telemetry` — opt-in toggles + payload preview. Telemetry consent is yours alone: the AI has no tool for it.
- **Costs** — `/settings/costs` — five-panel dashboard (totals + budget status + per-day + per-attribution + roll-up); plugin spend is split by the model the calls ran on
- **MCP tokens** — `/settings/mcp` — bearer tokens for `bunx @caelo-cms/mcp-server`
- **Plugins** — `/settings/plugins` — activation, grants and the awaiting-activation queue for every plugin
- **Email** — `/settings/email` — Resend / SMTP / SES selection
- **Gateway** — `/settings/gateway` — rate limits, captcha, body cap, request log. The AI can propose captcha / body-cap / auto-redeploy changes (`propose_set_gateway_settings`) for your approval.
- **Pending settings changes** — `/settings/owner-settings/pending` — budget, pricing and gateway proposals queued by an external agent over MCP (in the chat you approve on the card instead)
- **Users + roles** — `/settings/users` + `/settings/roles`. On Google Cloud installs, adding a user with a role also lets them through Google IAP (browser and MCP); deleting them or removing their last role takes that away again. You can also just ask the AI to invite or remove someone — it prepares the change and you click Approve.
- **Skills** — `/settings/skills` — AI behaviour bodies, AI-proposed queue
- **Subagents** — `/settings/subagents` — observability for spawn_subagent runs
- **Deployments** — `/settings/deployments` — Ops view with promote / rollback
- **Caelo updates** — `/settings/updates` — the Caelo version you run, the newest release with its notes, and for the Owner **Install update** (confirmed with a fresh Google sign-in, with a live timeline and the update history) or, where the install has no upgrader yet, the exact upgrade command with a copy button. On a self-hosted install the update is carried out by the [update agent](/install-self-hosted#installing-updates-from-the-admin) on your server; until it runs, the page shows the one command that sets it up. **Automatic updates** sets which kinds of release install on their own (security fixes, patch, minor; never major), a maintenance window, how long a release waits first, pause / resume, and shows the update emails sent to you; every change there is confirmed with a fresh Google sign-in. The bell links here when a release is out. The AI can tell you the version, whether an update is available, how past updates went and what the automatic updates will do next (`get_caelo_version`, `list_caelo_updates`, `get_caelo_auto_update_status`), but only you install it or change the policy.
- **DNS** — `/settings/dns` — records the active Pulumi stack expects
- **SEO** — `/settings/seo` — public site URL, sitemap toggle, Organization JSON-LD and site language. Publishing stops until the site URL and language are set; you can enter them here or tell the AI (it proposes the site URL with `propose_set_site_seo` and you approve, here or in the chat)

## Where the AI lives

Two surfaces:

1. **The live-edit chat overlay** — for editing pages (the primary surface)
2. **The standalone chat at `/content/chat`** — for everything else (plugin moderation, drafting kits, site-wide changes)

A third surface — **MCP** — exposes the same chat-runner outside the browser. See [`/mcp`](/mcp).

## What the AI can't do

Per `CLAUDE.md` §2 invariants:

- Can't write raw HTML to a page (only modules can be raw HTML, and those are versioned)
- Can't publish a page without your click
- Can't activate a plugin or grant it a capability without your click — shipped plugins included
- Can't trigger a deploy past staging without an Ops-role human
- Can't bypass the snapshot system; every write is reversible

You'll see these as `ActorScopeRejected` errors when the AI attempts them — the AI surfaces a "click here to do this yourself" message in the chat.

## Next

- [Live-edit overlay →](/admin-live-edit)
- [Build a plugin →](/plugins-build)
- [MCP server →](/mcp)
