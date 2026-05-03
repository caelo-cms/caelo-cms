---
slug: changelog
template: doc-page
locale: en
status: published
seo:
  title: Changelog — Caelo CMS
  description: Release notes for Caelo CMS. Pre-1.0 versions follow the no-fallbacks invariant — code paths fail loudly with structured errors when expected data is missing.
---

# Changelog

The canonical changelog lives in [`CHANGELOG.md`](https://github.com/caelo-cms/caelo-cms/blob/main/CHANGELOG.md) in the source repo and follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Pre-1.0 follows the **no-fallbacks invariant** documented in `CLAUDE.md` §2 — code paths fail loudly with structured errors when expected data is missing rather than silently substituting defaults. This rule is relaxed deliberately at 1.0.0 with a documented breaking-change policy.

## v0.1.0 — first OSS release

The product surface is complete; v0.1.0 is the dogfooding pass before 1.0.0.

What's in the box:

- **Pages, modules, templates, layouts** composed by reference, never by raw HTML on a page
- **Two-database split** — `cms_admin` + `cms_public` with RLS forced on every table both ways
- **Live-edit overlay** — your real site in a chrome-less iframe + a floating chat overlay; click any element, ask the AI, watch it change in place
- **Snapshot versioning + chat-keyed Undo** — every write emits a snapshot; every revert is one click
- **Multi-locale + URL strategies** — subdirectory / subdomain / separate domain, mixed within one site
- **AI translation** (Mode 1 + Mode 2) with per-locale glossary + style guide
- **Skills system** — Claude-style skill bodies the AI engages per turn, Owner-curated, AI-proposable
- **Subagents** — the AI spawns parallel reasoning loops on demand
- **Two-tier plugin host** — Tier 1 (signed, in-process, full SDK) + Tier 2 (Deno-sandboxed, locked SDK, AI-authorable)
- **Five core plugins** — forms, comments, newsletter, ratings, visitor auth (email/password + OAuth via Arctic)
- **API gateway** with rate-limiting + CAPTCHA / PoW + honeypot + debounced auto-redeploy
- **A/B experiments at the edge** — stable per-visitor hash + analytics-plugin attribution
- **Multi-provider AI** — Anthropic / OpenAI / Google / local OpenAI-compat behind a provider abstraction
- **Operation-type budgets** (text + image enforce independently)
- **Cost dashboard** — five panels (totals + budget status + per-day + per-attribution + roll-up)
- **Pulumi provisioning** — self-hosted + GCP + AWS + Azure adapters
- **MCP server** — drive your install from Claude Code or any MCP-aware client; same agent the live-edit chat uses

Per-phase per-line breakdown is in [`CHANGELOG.md`](https://github.com/caelo-cms/caelo-cms/blob/main/CHANGELOG.md) on GitHub.

## Status of this docs site

This page itself is rendered from a Caelo install (the very install the README at `https://github.com/caelo-cms/caelo-cms` documents). Every paper-cut visible here is a paper-cut against the product; we file them as issues and fix in real-time during the v0.1.0 dogfooding pass.
