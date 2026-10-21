<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./.github/brand/caelo-mark-dark.svg">
    <img src="./.github/brand/caelo-mark-light.svg" width="72" height="72" alt="Caelo logo">
  </picture>
</p>

<h1 align="center">Caelo</h1>

<p align="center">
  <strong>Open-source CMS for websites run with AI.</strong><br>
  The AI does the work. Caelo keeps your site in shape.
</p>

<p align="center">
  <a href="https://github.com/caelo-cms/caelo-cms/actions/workflows/ci.yml"><img src="https://github.com/caelo-cms/caelo-cms/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg" alt="License: MPL 2.0"></a>
  <a href="https://caelo-cms.com/docs/"><img src="https://img.shields.io/badge/docs-caelo--cms.com-blue" alt="Docs"></a>
</p>

---

An AI can build a good-looking website in minutes. Running it is the hard part: the tenth page should match the first, a colleague should be able to change something without breaking the design, a mistake should be easy to take back, and nobody should reach your data through an exposed admin login.

Caelo is built for that second day. You describe what you want, in the chat next to your live site or from your own agent. The AI builds it from your site's own parts. You review it, and you decide what goes live.

## Why Caelo

### One system instead of loose pages

Everything the AI builds comes from the same parts, so the site stays consistent and maintainable.

- Pages are assembled from layouts, templates and modules, styled by one theme. A page never holds raw HTML of its own.
- Plugins for languages, cookie consent, forms, newsletter, comments, ratings and visitor login ship with Caelo.
- SEO is structured fields (meta, canonical, Open Graph, JSON-LD, sitemap), not hand-written `<head>` markup. Moving a page creates its redirect.
- Staged builds get a quality check: Lighthouse, plus a structure check that catches the same component pasted as free HTML on several pages instead of being one module. A failed check keeps the site from going live until it is fixed or explicitly accepted.

### You decide

The AI works a lot and fast, but never over your head.

- Every change lands in a draft. The AI can stage its finished work for review; **Publish live is always a human click.**
- Hard-to-undo actions (deploys, users and roles, domains, themes and layouts, plugins, bulk deletes, URL moves) pause for your approval right in the chat.
- Every write is a snapshot. Undo works per chat; whole pages, modules or the site can be reverted.
- The same rules apply whether the work comes from the admin chat, the live-edit overlay or your own agent over MCP.

### Separated worlds

Visitors only ever reach finished pages. Where the site is built, nobody gets in without logging in.

- The public site is static HTML, served from object storage behind a CDN or from Caddy. Visitor writes (forms, comments, ratings) go through a separate, rate-limited API gateway that never holds admin credentials.
- On Google Cloud, the admin sits behind Identity-Aware Proxy before Caelo's own login is even reached.
- Two Postgres databases with isolated roles: authoring data and public plugin data never share one. Row-level security is forced on every table.
- Plugins the AI writes run in a Deno sandbox with no file, network or environment access, and get only the permissions the Owner grants for that exact version. Release images are signed and verified on install and on every upgrade.

### Getting there, and running it

- **Moving an existing site:** the AI crawls it (after you approve the crawl), rebuilds it page by page in Caelo, sets up redirects and reports what it carried over.
- **Your infrastructure, your AI:** MPL 2.0, running in your own cloud account or on your own server. Pick the model provider (Anthropic, OpenAI, Google, or a local OpenAI-compatible endpoint), see every AI call in the cost dashboard and cap it with budgets. Or drive the site from your own agent (Claude Code and others) over MCP, so the AI work runs on your agent's account instead of Caelo's.

## Status

**Pre-1.0, under active development.** Its own website, caelo-cms.com, is a Caelo install, but expect rough edges and breaking changes before 1.0. What works today: self-hosted with Docker Compose, and Google Cloud (`gcp`, `gcp-firebase`). AWS and Azure are planned, not available yet.

Until 1.0, Caelo deliberately fails loudly with a structured error where it could otherwise fall back to a silent default (`CLAUDE.md` §2). That rule is relaxed at 1.0 with a documented breaking-change policy.

## Install

### Self-hosted

On a Linux host with Docker and Bun, in the directory that should hold the install:

```bash
bunx @caelo-cms/provisioning@latest --provider self-hosted --domain example.com --owner-email you@example.com
```

That writes the configuration to `.caelo/`, starts Postgres, Caddy (automatic TLS), the admin app and the API gateway as a Docker Compose stack from signed, prebuilt images, and runs the migrations. Backups are `pg_dump`s plus the media and site files.

### Google Cloud, from the browser

No laptop needed: install into your own Google Cloud project from Cloud Shell.

| | |
|---|---|
| Google Cloud, load balancer + Cloud CDN (`gcp`) | [![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/caelo-cms/install&cloudshell_git_branch=release-v0.10.61&cloudshell_tutorial=gcp.md) |
| Google Cloud, Firebase Hosting (`gcp-firebase`) | [![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/caelo-cms/install&cloudshell_git_branch=release-v0.10.61&cloudshell_tutorial=gcp-firebase.md) |

Cloud Shell opens a short tutorial: sign in, run `./run.sh`, answer a few questions, confirm the monthly cost. The install then runs as a job in your project, so closing the tab doesn't stop it, and clicking the button again picks it up. The links are pinned to this release; `run.sh` verifies the provisioner's npm provenance and the release's signed manifest before anything runs ([how](https://github.com/caelo-cms/install#what-happens-when-you-click)).

### Google Cloud, from a terminal

```bash
bunx @caelo-cms/provisioning@latest --provider gcp     # or gcp-firebase
```

The wizard creates or reuses the project, prints a monthly cost estimate before anything billable is created, and provisions Cloud Run, Cloud SQL, the static hosting and Secret Manager with Pulumi. Staging is `noindex` and can be password-protected.

After any install, open the setup link it prints, create the Owner account and pick your AI provider. Everything else happens in the chat.

Updates install from Caelo itself: Settings → Updates, Update, confirm with your password. On Google Cloud that includes releases that change settings in your project (once the install has the converge job, which the install or one upgrade from a terminal sets up; installs from before Caelo's provisioner account keep installing those from a terminal, and the page says so); Caelo runs those as a signed job in your project, picks up where it stopped if the job is interrupted, and goes back to the previous release if the new one fails its test. Running `bunx @caelo-cms/provisioning@<version> upgrade` from a terminal does the same upgrade by hand.

## Drive it from your own agent

`@caelo-cms/mcp-server` connects any MCP client to your install, in one of two modes:

- **`caelo_chat`**: you describe an outcome, Caelo's own AI does the work.
- **Power-MCP**: your agent gets Caelo's full tool catalogue and runs the loop itself; by default Caelo makes no AI calls of its own.

Either way the agent works in the draft, and publishing stays with a human. Mint a token at `/settings/mcp` on your install; the page shows the exact setup for it in Claude Code, Claude Desktop, Codex CLI, Cursor, VS Code and Gemini CLI.

With Claude Code, Power-MCP looks like this:

```bash
claude mcp add caelo-admin \
  --env CAELO_ADMIN_URL=https://admin.example.com \
  --env CAELO_MCP_TOKEN=mcp_<token> \
  -- bunx --package @caelo-cms/mcp-server@latest caelo-admin-mcp
```

Then ask it for an outcome, for example *"Add a pricing page in our design system and stage it for review."* Details: [MCP and Power-MCP docs](https://caelo-cms.com/docs/mcp/).

## Documentation

User docs (install, editing, plugins, MCP, security) live at **[caelo-cms.com/docs](https://caelo-cms.com/docs/)**, built in Caelo itself.

For contributors: read **[`CONTRIBUTING.md`](./CONTRIBUTING.md)** and **[`CLAUDE.md`](./CLAUDE.md)** before opening a PR. The architecture overview is in **[`ARCHITECTURE.md`](./ARCHITECTURE.md)**, the product spec in **[`CMS_REQUIREMENTS.md`](./CMS_REQUIREMENTS.md)**, and the developer docs are indexed in **[`docs/README.md`](./docs/README.md)**.

## Roadmap

The roadmap lives on the GitHub Project board: **[Caelo Roadmap](https://github.com/orgs/caelo-cms/projects/1)**. Issues are tagged with Area, Priority and Size and move through Backlog, Ready, In progress, In review and Done.

## Local development

Prerequisites: [Bun](https://bun.sh/) 1.4.2 or newer (the version pinned in `packageManager` and CI; 1.3.x breaks the plugin-sandbox bundling the tests rely on), Docker with Docker Compose, [Deno](https://deno.com) 2 or newer (for the plugin sandbox), and an API key for an AI provider.

```bash
git clone https://github.com/caelo-cms/caelo-cms.git
cd caelo-cms
cp .env.example .env                  # then add your AI provider key
bun install
docker compose up -d                  # Postgres + Caddy
bun run db:migrate                    # cms_admin + cms_public migrations
bun run --filter @caelo-cms/admin seed:dev
bun run --filter @caelo-cms/admin dev     # admin at http://localhost:5173
```

All configuration lives in the root `.env`; the admin's `dev` and `seed:dev` scripts load it from there, so you can also run them from `apps/admin`. Ports, the staging URL and the importer allowlist for local migration tests are in the optional block at the end of `.env.example`; see [`CONTRIBUTING.md`](./CONTRIBUTING.md#local-development-loop) for when you need them.

Verify before opening a PR:

```bash
bun run lint            # Biome + audit-callsites + SPDX headers
bun run typecheck
bun run test            # unit + integration; truncates the databases in .env, so never point it at data you want to keep
bun run license:check   # transitive license allowlist
```

## License

[MPL 2.0](./LICENSE). Maximum freedom for developers and hosting providers; modifications to core files stay open; one license, no dual licensing.

All dependencies are MPL-2.0-compatible (MPL-2.0, Apache-2.0, MIT, BSD, ISC). `bun run license:check` enforces this in CI.

## Security

Report vulnerabilities via **[GitHub Private Vulnerability Reporting](https://github.com/caelo-cms/caelo-cms/security/advisories/new)**. Full policy in **[`SECURITY.md`](./SECURITY.md)**.

## Contributing

See **[`CONTRIBUTING.md`](./CONTRIBUTING.md)**. New here? Start with an issue labeled [`good first issue`](https://github.com/caelo-cms/caelo-cms/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22). Questions, ideas and show-and-tell go to [Discussions](https://github.com/caelo-cms/caelo-cms/discussions). Code of Conduct: the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
