# `@caelo-cms/mcp-server`

MCP servers for your Caelo CMS install. Two surfaces, selected by the
token's scope:

- **`caelo_chat`** (default mode, scope `chat`) — one tool that talks
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
[docs page](https://caelo-cms.com/mcp) for the full Power-MCP working
model (work sessions, preview branches, approval gates).

## Install

In your Caelo install:

1. Visit `/security/mcp` as an Owner.
2. Click **New token**, give it a name (`claude-code`, `laptop`, `ci`,
   etc.), optionally set an AI-spend cap (microcents), and copy the
   bearer that's shown ONCE.
3. The page renders the exact `claude mcp add` snippet — copy + run it.

Manual setup if your client isn't Claude Code:

```bash
# stdio server invoked by your MCP-aware client
bunx @caelo-cms/mcp-server
```

with these env vars set:

| Variable | Required | Notes |
|---|---|---|
| `CAELO_ADMIN_URL` | yes | `https://admin.example.com` — point at your install. |
| `CAELO_MCP_TOKEN` | yes | Bearer minted at `/security/mcp`. |

## The `caelo_chat` tool

| Field | Type | Notes |
|---|---|---|
| `message` | string, required | What you want to say to the Caelo agent. |
| `chatSessionId` | uuid, optional | Continue an existing chat session. |
| `pageId` | uuid, optional | Bind a NEW chat to one page so the agent's page-context block populates. |

Output: assistant reply text + a JSON block with `chatSessionId` (for
the next call), `requestId` (click through to
`/security/audit/<requestId>` for the full audit trail), the structured
tool-call summaries the agent dispatched, the per-turn cost in
microcents, and a `pendingProposals` count so the agent can surface
"you have N things waiting for Owner approval".

## Why a single tool?

Browse / publish / propose actions happen *through* the chat — "which
pages exist?" → the Caelo agent calls `pages.list` internally → answers
in text. Same auth surface, same RLS scoping, same audit trail, same
propose-execute Owner gate as the browser. The remote agent talks to a
human-equivalent agent, not to a programmatic API.

## License

MPL-2.0.
