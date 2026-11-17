# Caelo CMS plugin for Claude Code

Edit a [Caelo CMS](https://caelo-cms.com) site from Claude Code. The plugin connects to your site's Power-MCP address by URL (the full tool catalogue for pages, modules, themes, media, SEO and staging), you sign in with your Google account, and three short skills keep the agent inside Caelo's safety model: every change lands in a draft, staging runs a Lighthouse quality check, and **Publish live is always a person's click in the Caelo admin**. Approval-gated actions (themes, layouts, users, domains, deploys, bulk deletes) wait for an approval there.

There is no token and nothing to install on your machine. What the agent may do follows your role on the site, and everything it does is recorded under your name.

## Which plugin

| Your Caelo install | Plugin |
|---|---|
| On Google Cloud, and Settings → MCP shows a Power-MCP URL | `caelo` (this one) |
| Self-hosted, AWS or Azure, or a CI job | [`caelo-token`](https://github.com/caelo-cms/caelo-cms/tree/main/integrations/claude-code-token): Caelo's local MCP server with a token |

Both bring the same skills. If you installed `caelo` before it connected by URL and use a token, switch to `caelo-token`; your install's URL and token are entered once more there.

## Install

```bash
claude plugin marketplace add caelo-cms/caelo-cms
claude plugin install caelo@caelo-cms
```

Or inside a session: `/plugin marketplace add caelo-cms/caelo-cms`, then `/plugin install caelo@caelo-cms`.

Claude Code then asks for one option:

| Option | What to enter |
|---|---|
| `mcp_url` | The MCP URL from **Settings → MCP** in your Caelo admin, in the box "Power-MCP: your AI tool does the work". It ends in `/api/mcp/power` |

Start a new session, run `/mcp`, select `caelo` and choose **Authenticate**. A page of your Caelo site names the app and what it gets access to; after you approve, Google asks you to sign in. The sign-in lasts 30 days.

Change the URL later with `/plugin` or `claude plugin configure caelo@caelo-cms`.

**Requirements:** a Caelo install on Google Cloud with Google sign-in set up (Settings → Google sign-in, once per site, by an Owner), and a user on that site whose role may edit content. No install yet? See [Install](https://github.com/caelo-cms/caelo-cms#install).

## Skills

| Skill | Use it for |
|---|---|
| `/caelo:connect` | Setting up and checking the connection: the URL, the sign-in, and what a refusal means |
| `/caelo:edit-site` | The safe editing loop: session, site context, change, screenshot, stage, quality check, hand over for Publish live |
| `/caelo:handover` | Moving a site you built or prototyped with Claude Code, or an existing live site, into Caelo's theme, templates and modules |

Claude also picks them up on its own when a request matches. The server itself tells the agent to open a session and read the site context first, so the install's own skills (brand voice, migration, design) apply too.

### In claude.ai, Claude Desktop and Cowork

The skills are not tied to Claude Code. Where plugins can be installed or uploaded, they load there too; the connection is then a custom connector with the same MCP URL (Settings → Connectors → Add custom connector), because a plugin's own server entry is not used there. `/caelo:connect` describes both ways.

## What it connects to and where data goes

- The plugin holds no code that runs on your machine: it declares one remote MCP server, the URL you enter. Claude Code talks to it over HTTPS.
- The sign-in runs through your Caelo site's own sign-in service and Google. Claude Code gets a token that only works for this address of your site; your Caelo install checks your Google identity and your role on every request.
- Some tools make your Caelo install fetch other websites (for example `inspect_external_page`, `screenshot_external_page`, `import_media_from_urls`, `propose_site_import`); those requests come from your install, not from this machine.
- Every call is recorded in your install's audit trail. An Owner sees the connected app under Settings → MCP and can revoke it there. The plugin contains no telemetry.

## Other clients

ChatGPT, claude.ai, Cursor, VS Code, Codex CLI and Gemini CLI connect with the same URL; **Settings → MCP → Remote** in your Caelo admin shows the steps for each. Docs: [caelo-cms.com/docs/mcp](https://caelo-cms.com/docs/mcp/).

## License

MPL-2.0, like the rest of [Caelo](https://github.com/caelo-cms/caelo-cms). Support: [GitHub issues](https://github.com/caelo-cms/caelo-cms/issues).
