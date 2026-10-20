# `@caelo-cms/mcp-server`

MCP servers for your Caelo CMS install. Two surfaces, selected by the
token's scope:

- **`caelo_chat`** (default mode, scope `chat`) — talks
  to Caelo's own AI agent. You describe an outcome; Caelo's chat-runner
  does the work.
- **Power-MCP** (`caelo-admin-mcp` binary / `caelo-mcp-server admin`,
  scope `admin`) — the full chat-runner tool catalogue exposed
  directly, so YOUR agent (Claude Code et al.) drives the tool loop and
  Caelo makes no provider calls of its own. `caelo-mcp-server export`
  additionally writes a CLAUDE.md + `.claude/skills/` tree generated
  from the install's live context.

Every mode is a thin shim: calls become HTTPS POSTs against your admin
install's `/api/mcp/*` endpoints, which dispatch into the same
chat-runner machinery that powers the live-edit overlay. See the
[MCP page](https://caelo-cms.com/docs/mcp/) in the docs for the full Power-MCP working
model (work sessions, the shared draft, approval gates).

## Install

In your Caelo install:

1. Visit `/settings/mcp` as an Owner.
2. Click **New token**, give it a name (`claude-code`, `laptop`, `ci`,
   etc.), optionally set an AI-spend cap (microcents), and copy the
   bearer that's shown ONCE.
3. The page shows ready-to-copy setup for Claude Code, Claude Desktop,
   Codex CLI, Cursor, VS Code and Gemini CLI — a terminal command or a
   JSON config entry, plus how the client picks it up.

Desktop apps (Claude Desktop, Cursor, VS Code) don't inherit your
terminal's PATH: put the full path of `bunx` (`which bunx`) into their
config instead of the bare name.

ChatGPT and claude.ai in the browser can't use this server: they only
connect to MCP servers hosted on the internet (Streamable HTTP + OAuth),
and this one runs on your machine over stdio. Tracked in #806.

Manual setup for any other MCP-aware client:

```bash
# stdio server invoked by your MCP-aware client
bunx @caelo-cms/mcp-server@latest
```

It switches to the exact release your install runs at startup (see the
[MCP page](https://caelo-cms.com/docs/mcp/) in the docs), so the command never needs a
version; `@latest` keeps `bunx` from reusing an older cached install.

with these env vars set:

| Variable | Required | Notes |
|---|---|---|
| `CAELO_ADMIN_URL` | yes | `https://admin.example.com` — point at your install. Must be `https://` (plain `http://` only for localhost). |
| `CAELO_MCP_TOKEN` | yes | Bearer minted at `/settings/mcp`. |
| `CAELO_IAP_SERVICE_ACCOUNT` | on GCP installs | The admin's MCP service account. `/settings/mcp` includes it in every client snippet when the admin is behind Google IAP. |

Without `CAELO_ADMIN_URL` or `CAELO_MCP_TOKEN` the server still starts and
lists its tools (MCP directories inspect servers that way), but every
tool call fails and names the variable to set. Power-MCP then lists the
catalogue shipped with this release (`power-catalogue.json`); once
configured it always lists your admin's live catalogue, including plugin
tools. `export` exits instead.

### Installs behind Google IAP (GCP)

On `gcp` and `gcp-firebase` installs the admin sits behind Identity-Aware Proxy, which rejects every request before Caelo sees it unless it carries a Google credential. With `CAELO_IAP_SERVICE_ACCOUNT` set, the server signs a short-lived JWT as that service account (IAM Credentials `signJwt`, using your Application Default Credentials) and sends it in `Authorization` next to `x-caelo-mcp-token`: IAP checks the first, Caelo the second.

One-time setup on your machine:

```bash
gcloud auth application-default login
```

The provisioner creates the service account (`caelo-mcp@<project>`), allowlists it on IAP and lets everyone on the IAP allowlist sign as it — on new installs via Pulumi, on existing ones during `cms-provision upgrade`. No service-account keys are involved.

## The `caelo_chat` tool

| Field | Type | Notes |
|---|---|---|
| `message` | string, required | What you want to say to the Caelo agent. |
| `chatSessionId` | uuid, optional | Continue an existing chat session. |
| `attachments` | array, optional | Up to four image references returned by `caelo_upload_images`. |
| `pageId` | uuid, optional | Bind a NEW chat to one page so the agent's page-context block populates. |

Output: assistant reply text + a JSON block with `chatSessionId` (for
the next call), `requestId` (click through to
`/settings/audit/<requestId>` for the full audit trail), the structured
tool-call summaries the agent dispatched, the per-turn cost in
microcents, and a `pendingProposals` count so the agent can surface
"you have N things waiting for Owner approval".

## Why route editing through chat?

Browse / publish / propose actions happen *through* the chat — "which
pages exist?" → the Caelo agent calls `pages.list` internally → answers
in text. Same auth surface, same RLS scoping, same audit trail, same
propose-execute Owner gate as the browser. The remote agent talks to a
human-equivalent agent, not to a programmatic API.

## License

MPL-2.0.

## Image uploads

Both modes expose `caelo_upload_images`. For example, call it with:

```json
{"images":[{"filePath":"/home/me/Pictures/character.png","alt":"Main character reference"}]}
```

Paths are local to the MCP process. Alternatively use `base64` plus an optional `filename`; supply exactly one of `filePath` and `base64`. Uploads support PNG/JPEG/WebP/GIF, up to 5 MiB each, with at most four files per call. The result contains per-file successes/errors and an `attachments` array. Pass that array to `caelo_chat` alongside `message` to send actual image content to Caelo's AI. In admin mode, the returned asset IDs can be used with regular media/page tools.

The token owner's current `content.write` permission is required for either scope. Images are stored in the shared CMS media library; admin previews require authentication. Uploading alone does not publish a page. A partial batch keeps successful uploads — retry only the failed entries. See the [MCP page](https://caelo-cms.com/docs/mcp/) in the docs for HTTP examples and server limits.
