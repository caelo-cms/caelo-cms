---
slug: home
template: landing
locale: en
status: published
seo:
  title: Caelo CMS — AI-first, open-source CMS
  description: Talk to your site. The AI agent edits modules, drafts pages, translates copy. You review, you publish. MPL 2.0. Self-hostable.
  ogTitle: Caelo CMS
  ogDescription: AI-first, open-source CMS. MPL 2.0. Self-hostable on a single VM or one-click deploy to GCP / AWS / Azure.
---

::: hero
# Talk to your site.
The AI edits modules, drafts pages, translates copy, moderates comments. **You review, you publish.** Every action is a snapshot you can revert with one click.

[Quickstart →](/quickstart) · [GitHub →](https://github.com/caelo-cms/caelo-cms)
:::

::: content
## Built for the AI agent as the primary user

Caelo's architecture is layered so the AI can't ship a page without your click. Live-edit overlay shows your real site while you work. Two-database split with RLS forced everywhere. Snapshot versioning means every change is reverted by clicking back through chat history.

```
talk → preview → publish.
```

### Install in one line

```bash
bunx @caelo/provisioning --provider self-hosted
```

Self-hosted = Docker Compose with Postgres + pgBackRest + Caddy (auto-SSL) + the admin + the API gateway. Cloud = `--provider gcp` / `aws` / `azure` — Pulumi spins up Cloud SQL HA + managed object storage + the platform's CDN + Secret Manager.

### Drive your install from your IDE

```bash
claude mcp add caelo --command "bunx @caelo/mcp-server" \
  --env CAELO_ADMIN_URL=https://your-install.example.com \
  --env CAELO_MCP_TOKEN=$(your bearer)
```

Same chat-runner that powers the live-edit overlay, exposed via MCP. Read pages, propose edits, queue Owner-approval proposals — without opening the browser.

### Four pillars

- **AI-first** — the chat runs the editor; the panel is for security + ops.
- **Open** — MPL 2.0, every dep MPL-compatible. No CLA. No dual-licensing.
- **Self-hostable** — one VM works. Cloud works. Multi-region works.
- **Opinionated** — small kernel, plugin host for the rest. Tier 1 (signed, in-process) + Tier 2 (Deno-sandboxed, AI-authored).
:::

::: cta
## Status: pre-1.0 (v0.1.0)

The product surface is complete; we're in the dogfooding pass. Expect rough edges in the first 30 days; we fix in real-time. The pre-1.0 invariant: every code path that could "default to something sensible when data is missing" instead **fails loudly with a structured error**. Relaxed at 1.0.0.

[Read the architecture →](/architecture) · [Build a plugin →](/plugins-build) · [Security policy →](/security)
:::
