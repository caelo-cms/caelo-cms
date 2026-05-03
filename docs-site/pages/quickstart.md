---
slug: quickstart
template: doc-page
locale: en
status: published
seo:
  title: Quickstart — Caelo CMS
  description: From zero to a working Caelo install in under 10 minutes. Self-hosted via `bunx @caelo/provisioning --provider self-hosted`.
---

# Quickstart

This is the "get something running in the next 10 minutes" path. For the long-form per-provider docs, see the install guides linked at the bottom.

## What you need

- A Linux host with Docker + [Bun](https://bun.sh) ≥ 1.3 installed
- A domain you can point at the host (for production TLS) — for local-only testing, `localhost` works
- An [Anthropic API key](https://console.anthropic.com/) (the AI provider) — optional for the basic install, required to use the chat surface

## Install

```bash
bunx @caelo/provisioning --provider self-hosted \
  --domain your-domain.example.com \
  --anthropic-key sk-ant-...
```

This stands up a Docker Compose stack:

- **Postgres** with `pgBackRest` for WAL backups
- **Caddy** with automatic Let's Encrypt TLS for your domain
- The **admin app** (SvelteKit + Bun) on `https://your-domain.example.com`
- The **API gateway** for visitor-facing plugin endpoints

You'll be prompted for an Owner email + password during the install. Save them somewhere safe — there's no "forgot password" flow yet (P17 review-pass item).

## First thing to do

1. Open `https://your-domain.example.com` in your browser
2. Log in as the Owner you just created
3. You'll land on a dashboard with a "Live edit" button — click it
4. The seed install ships with a single `home` page; you'll see it in an iframe with a floating chat overlay
5. Type "make the headline more interesting" in the chat — the AI will draft an edit, the iframe will re-render with the change, and a "Publish" button will appear in the toolbar

That loop — talk → preview → publish — is the whole product.

## Drive it from your IDE (optional)

If you use Claude Code (or any MCP-aware client):

1. As Owner, navigate to `/security/mcp` on your install
2. Click **New token**, name it (`claude-code`, `laptop`, etc.), copy the bearer
3. The page renders the exact `claude mcp add` snippet — copy and run it in your terminal
4. Now `caelo_chat` is available as a tool inside Claude Code; talk to your install from anywhere

## Next steps

- **Per-provider install guides:** [self-hosted](/install-self-hosted) · [GCP](/install-gcp) · [AWS](/install-aws) · [Azure](/install-azure)
- **Architecture overview:** [`/architecture`](/architecture)
- **Build a plugin:** [`/plugins-build`](/plugins-build)
- **Talk to Caelo via MCP:** [`/mcp`](/mcp)
