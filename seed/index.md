---
path: /docs/
title: "Caelo documentation"
description: "Install Caelo, build and run your site with the AI, publish by click. Open source (MPL 2.0), on your own server or your own Google Cloud project."
---

# Caelo documentation

Caelo is an open-source CMS for websites run with AI. You describe what you want, in the chat next to your live site or from your own agent. The AI builds it from your site's own parts. You review it, and you decide what goes live: every change lands in a draft, and **Publish live is always a human click**. Every write is a snapshot you can revert.

## Install

What works today: self-hosted with Docker Compose, and Google Cloud (`gcp`, `gcp-firebase`). AWS and Azure are planned, not available yet.

**Self-hosted**, on a Linux host with Docker and Bun, in the directory that should hold the install:

```bash
bunx @caelo-cms/provisioning@latest --provider self-hosted --domain example.com --owner-email you@example.com
```

That starts Postgres, Caddy (automatic TLS), the admin app and the API gateway as a Docker Compose stack from signed, prebuilt images. See [Install: self-hosted](/docs/install/self-hosted/).

**Google Cloud, from the browser**, no laptop needed: [![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/caelo-cms/install&cloudshell_git_branch=release-v0.10.52&cloudshell_tutorial=gcp.md) ([Firebase Hosting variant](https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/caelo-cms/install&cloudshell_git_branch=release-v0.10.52&cloudshell_tutorial=gcp-firebase.md), [how it works](/docs/install/google-cloud/#one-click-install-from-cloud-shell)). The installer prints a monthly cost estimate before it creates anything billable.

After any install, open the setup link it prints, create the Owner account and pick your AI provider. Everything else happens in the chat. Start with the [Quickstart](/docs/quickstart/).

## Drive your install from your own agent

Mint a token at `/settings/mcp` on your install; the page shows the exact `claude mcp add` command for it. Two modes: `caelo_chat` (you describe an outcome, Caelo's own AI does the work) and Power-MCP (your agent gets Caelo's full tool catalogue). Either way the agent works in the draft, and publishing stays with a human. See [MCP](/docs/mcp/).

## Status: pre-1.0

Caelo is under active development; expect rough edges and breaking changes before 1.0. Until 1.0, Caelo deliberately fails loudly with a structured error where it could otherwise fall back to a silent default. That rule is relaxed at 1.0 with a documented breaking-change policy.

[Architecture →](/docs/architecture/) · [Build a plugin →](/docs/plugins/build/) · [Security policy →](/docs/security/) · [GitHub →](https://github.com/caelo-cms/caelo-cms)
