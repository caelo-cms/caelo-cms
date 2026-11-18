---
name: connect
description: Connect to a Caelo CMS site by URL and check the connection. Use when the user wants to set up Caelo, when the caelo tools are missing or the caelo server needs authentication, when a call is refused (not a user of this site, role, revoked, blocked, remote MCP off), or when the user asks how to get a Caelo site at all.
---

# Connect to Caelo

The connection is one URL: the site's Power-MCP address. The user signs in with their own Google account, and what they may do follows their role on the site. There is no token and nothing to install. Everything the agent does is recorded under that person.

## 1. Check what is missing

Call `caelo_open_session`. If it works, the connection is fine: continue with the `edit-site` skill. If it fails, read the error; it names the next step. If the caelo tools are missing altogether, ask the user to run `/mcp` in Claude Code and read the `caelo` entry. Typical cases:

| `/mcp` or the error says | Cause | Fix |
|---|---|---|
| URL is unset or invalid | The plugin's MCP URL option is empty | Step 2 |
| Needs authentication | Not signed in yet, or the sign-in is older than 30 days | Step 3 |
| `not_a_caelo_user` | The Google account is not a user of this site | An Owner adds the person under Settings → Users, with a role |
| `permission_denied` | The person's role does not allow this address; the message names the missing permission and the roles that have it | An Owner changes the role under Settings → Users |
| `remote_access_revoked` | An Owner revoked this app for this person | An Owner restores it under Settings → MCP |
| `remote_access_blocked` | An Owner blocked every app of this person | An Owner lifts the block under Settings → MCP |
| 404 with `"configured": false`, or `remote_mcp_not_configured` | Connecting by URL is off on this site | Step 4 |
| HTTP 429, "at capacity" | The site is busy | Wait the seconds it names, then send the same call again |

Never ask the user for a password or a token: this connection has neither.

## 2. Set the URL

The user finds it in the Caelo admin under **Settings → MCP**, in the box **Power-MCP: your AI tool does the work**: the MCP URL, ending in `/api/mcp/power`. (A site on an older Caelo release shows an address ending in `/api/mcp/admin`; that one works too.) The chat address (`/api/mcp/chat`) is not for this plugin: its skills use the Power-MCP tools.

- In Claude Code: `/plugin`, select the `caelo` plugin, configure its option.
- In a terminal: `claude plugin configure caelo@caelo-cms`.

Then start a new Claude Code session, so the plugin connects with the new value.

## 3. Sign in

In Claude Code run `/mcp`, select `caelo` and choose **Authenticate**. The browser opens a page of the Caelo site that names the app and what it gets access to. After **Approve**, Google asks the user to sign in. Back in Claude Code the `caelo` tools appear; go back to step 1.

The sign-in lasts 30 days. An Owner sees the connected app under Settings → MCP and can revoke it there.

## 4. Connecting by URL is not available

Connecting by URL exists on Caelo installs on Google Cloud, once an Owner has set up Google sign-in (Settings → Google sign-in in the Caelo admin). If the site is on Google Cloud, that is the step to ask an Owner for.

Self-hosted, AWS and Azure installs connect with a token and Caelo's local MCP server. For those, install the other plugin and remove this one:

```
claude plugin install caelo-token@caelo-cms
claude plugin uninstall caelo@caelo-cms
```

## 5. In claude.ai, Claude Desktop or Cowork

There the connection is a custom connector, not a plugin option: **Settings → Connectors → Add custom connector**, the same MCP URL, **Connect**, sign in with Google. Name it as the Caelo admin suggests (`Caelo <site> (Power)`), so it stays apart from a chat connector to the same site. The `edit-site` and `handover` skills work the same with it.

## 6. No Caelo install yet

Caelo is self-hosted and open source (MPL 2.0). Point the user to the install section of https://github.com/caelo-cms/caelo-cms (a Google Cloud install from Cloud Shell, or Docker Compose on a Linux host with Docker and Bun). After the install, the setup link it prints creates the Owner account; then continue with step 2. Docs: https://caelo-cms.com/docs/ and https://caelo-cms.com/docs/mcp/.
