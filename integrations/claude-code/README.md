# Caelo CMS plugin for Claude Code

Edit a self-hosted [Caelo CMS](https://caelo-cms.com) site from Claude Code. One install gives you Caelo's MCP server in Power-MCP mode (the full tool catalogue for pages, modules, themes, media, SEO and staging) and three short skills that keep the agent inside Caelo's safety model: every change lands in a draft, staging runs a Lighthouse quality check, and **Publish live is always a person's click in the Caelo admin**. Approval-gated actions (themes, layouts, users, domains, deploys, bulk deletes) wait for the Owner's approval there.

## Install

```bash
claude plugin marketplace add caelo-cms/caelo-cms
claude plugin install caelo@caelo-cms
```

Or inside a session: `/plugin marketplace add caelo-cms/caelo-cms`, then `/plugin install caelo@caelo-cms`.

Claude Code then asks for three options:

| Option | What to enter |
|---|---|
| `admin_url` | Your admin's address, e.g. `https://admin.example.com` |
| `mcp_token` | A token with scope **admin**, minted as Owner at `/settings/mcp` (shown once, stored in your system keychain) |
| `iap_service_account` | Only on Google Cloud installs behind IAP: the value `/settings/mcp` shows. Leave empty otherwise |

Change them later with `/plugin` or `claude plugin configure caelo@caelo-cms`. Without a URL and token the server still starts and lists its tools; each call then names the missing value.

**Requirements:** [Bun](https://bun.sh) on the machine running Claude Code (the server starts with `bunx`), and a Caelo install. No install yet? See [Install](https://github.com/caelo-cms/caelo-cms#install): Docker Compose or your own Google Cloud project.

## Skills

| Skill | Use it for |
|---|---|
| `/caelo:connect` | Setting up and checking the connection, fixing token, URL, IAP or Bun problems |
| `/caelo:edit-site` | The safe editing loop: session, site context, change, screenshot, stage, quality check, hand over for Publish live |
| `/caelo:handover` | Moving a site you built or prototyped with Claude Code, or an existing live site, into Caelo's theme, templates and modules |

Claude also picks them up on its own when a request matches. The server itself tells the agent to open a session and read the site context first, so the install's own skills (brand voice, migration, design) apply too.

## What it runs and where data goes

- The MCP server is the npm package [`@caelo-cms/mcp-server`](https://www.npmjs.com/package/@caelo-cms/mcp-server) (MPL-2.0, source in [`packages/mcp-server`](https://github.com/caelo-cms/caelo-cms/tree/main/packages/mcp-server)), started as `bunx --package @caelo-cms/mcp-server@<version> caelo-admin-mcp`. At startup it asks your admin which release it runs and, if that differs, restarts itself as exactly that release (downloaded from npm by `bunx`).
- It sends requests only to the admin URL you configure, with your token. On Google Cloud installs with `iap_service_account` set, it also asks Google's IAM Credentials API to sign a short-lived token with your Application Default Credentials.
- Some tools make your Caelo install fetch other websites (for example `inspect_external_page`, `screenshot_external_page`, `import_media_from_urls`, `propose_site_import`); those requests come from your install, not from this machine.
- Every call is recorded in your install's audit trail. The plugin contains no telemetry.

## Other clients

The same server works in any MCP client that can start a local command; `/settings/mcp` on your install shows the exact setup for Claude Desktop, Codex CLI, Cursor, VS Code and Gemini CLI. Docs: [caelo-cms.com/docs/mcp](https://caelo-cms.com/docs/mcp/).

## License

MPL-2.0, like the rest of [Caelo](https://github.com/caelo-cms/caelo-cms). Support: [GitHub issues](https://github.com/caelo-cms/caelo-cms/issues).
