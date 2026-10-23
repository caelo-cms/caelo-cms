---
name: connect
description: Connect Claude Code to a Caelo CMS install and check the connection. Use when the user wants to set up Caelo, when a caelo tool says CAELO_ADMIN_URL or CAELO_MCP_TOKEN is not set, when the connection fails (401, IAP, version mismatch), or when the user asks how to get a Caelo site at all.
---

# Connect to Caelo

The plugin starts Caelo's MCP server (`@caelo-cms/mcp-server`, Power-MCP mode) as the MCP server `caelo`. It needs three things: Bun on this machine, the admin URL of a Caelo install, and an admin-scoped MCP token from that install. Without URL and token the server still starts and lists its tools, but every call fails and names the missing value.

## 1. Check what is missing

Call `caelo_open_session`. If it works, the connection is fine: continue with the `edit-site` skill. If it fails, read the error; it names the next step. If the caelo tools are missing altogether, the server stopped at startup (with URL and token set it checks them, and the admin's release, before it starts): ask the user to open `/mcp` in Claude Code and read the `caelo` server's error. Typical cases:

| Error mentions | Cause | Fix |
|---|---|---|
| `CAELO_ADMIN_URL` / `CAELO_MCP_TOKEN` not set | Plugin options empty | Step 2 |
| `must use https://` | URL starts with `http://` | Use the `https://` address (plain http only for localhost) |
| HTTP 401 / token rejected | Token revoked, expired (tokens last 90 days) or chat-scoped | Mint a new token with scope `admin` (step 3) |
| Google IAP | Install on Google Cloud behind IAP | Set the IAP service account option and run `gcloud auth application-default login` once |
| Version handshake, `bunx` not found | Bun missing or the admin unreachable | Install Bun (https://bun.sh), check the URL opens in a browser |

The MCP server runs as a child process of Claude Code, so `bunx` has to be on the PATH Claude Code was started with.

## 2. Set the plugin options

Never ask the user to paste the token into the chat, and never write it into a file. The user enters it themselves in one of these places:

- In Claude Code: `/plugin`, select the `caelo` plugin, configure its options.
- In a terminal: `claude plugin configure caelo@caelo-cms` shows which options are unset; `--values-stdin` saves values from a JSON object, which keeps the token out of the shell history if it comes from a file or a password manager.

Options: `admin_url` (e.g. `https://admin.example.com`), `mcp_token` (stored in the system keychain), `iap_service_account` (Google Cloud installs only; `/settings/mcp` shows the value). After changing them, start a new Claude Code session so the server restarts with the new values, then go back to step 1.

## 3. Get a token

As Owner, open `/settings/mcp` on the install, click **New token**, choose scope **admin**, optionally set an AI cost cap, and copy the token (it is shown once). Leave **Agent may use Caelo's AI** off unless the user wants Caelo's own AI calls on the install's key. The page also shows ready-made setups for other clients.

## 4. No Caelo install yet

Caelo is self-hosted and open source (MPL 2.0). Point the user to the install section of https://github.com/caelo-cms/caelo-cms (Docker Compose on a Linux host with Docker and Bun, or a Google Cloud install from Cloud Shell). After the install, the setup link it prints creates the Owner account; then continue with step 3. Docs: https://caelo-cms.com/docs/ and https://caelo-cms.com/docs/mcp/.
