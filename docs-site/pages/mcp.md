---
slug: mcp
template: doc-page
locale: en
status: published
seo:
  title: Talk to Caelo from your IDE — MCP server
  description: Drive your Caelo install from Claude Code, Cursor, or any MCP-aware client. Same chat-runner; same auth, audit, RLS. One tool — caelo_chat — by design.
---

# Talk to Caelo from your IDE — MCP server

The MCP server (`@caelo-cms/mcp-server`) exposes your Caelo install's chat-runner as a single tool: **`caelo_chat`**. Lets Claude Code (or any [Model Context Protocol](https://modelcontextprotocol.io)–aware client) drive your install — read pages, propose edits, queue Owner-approval proposals, summarise plugin data — without opening the browser.

## Why it exists

The browser chat is one consumer of the chat-runner. The chat-runner is also reachable from:

- An MCP-aware IDE (Claude Code, Cursor, etc.) — talk to your install while you're already coding
- A CI job — schedule "draft tomorrow's blog post" to land at 3am as a draft snapshot
- Your terminal — `bun run mcp-cli` (a tiny REPL that wraps `caelo_chat`)

Anything outside the browser had no way in until MCP. Now there's one.

## Why a single tool

You'd think you'd want `caelo_list_pages`, `caelo_publish`, `caelo_pending_proposals` as separate MCP tools. We deliberately don't ship those. Instead:

- "Which pages exist?" → say it to `caelo_chat` → the agent calls `pages.list` internally → answer in text
- "Publish the draft" → say it to `caelo_chat` → the agent invokes the publish op (or asks you to confirm if it's a hard-to-revert change)
- "What's waiting for my approval?" → the agent surfaces `pendingProposals` in every response

**The remote agent talks to a human-equivalent agent, not to a programmatic API.** Same auth surface, same RLS scoping, same audit trail, same propose-execute Owner gate. One tool keeps the security model honest.

## Install

In your Caelo install:

1. As Owner, navigate to `/security/mcp`
2. Click **New token**, give it a name (`claude-code`, `laptop`, `ci`), optionally set an AI-spend cap in microcents (USD × 10⁸), and copy the bearer that's shown ONCE
3. The page renders the exact `claude mcp add` snippet — copy + run it

Manual setup:

```bash
claude mcp add caelo --command "bunx @caelo-cms/mcp-server" \
  --env CAELO_ADMIN_URL=https://your-install.example.com \
  --env CAELO_MCP_TOKEN=mcp_<32-bytes-hex>
```

Other MCP clients use whatever their stdio-server registration syntax is; the env vars are the same.

## The `caelo_chat` tool

| Field | Type | Notes |
|---|---|---|
| `message` | string, required | What you want to say to the Caelo agent |
| `chatSessionId` | UUID, optional | Continue an existing chat session |
| `pageId` | UUID, optional | Bind a NEW chat to one page so the agent's page-context block populates |

Output (returned as MCP content blocks): the assistant's reply text + a JSON block with:

```json
{
  "chatSessionId": "<uuid>",
  "requestId": "<uuid>",
  "toolCalls": [
    { "name": "edit_module", "summary": "...", "succeeded": true }
  ],
  "pendingProposals": 3,
  "costMicrocents": 412300
}
```

`requestId` is your click-through to `/security/audit/<requestId>` for the full audit trail of what the agent dispatched on your behalf.

## What you can do

Anything the browser chat can do. Some examples:

- **Drafting:** "draft a new page at /pricing with a hero, three tiers, and a CTA section"
- **Editing:** "rename the home page from 'Welcome' to 'Caelo CMS — talk to your site'" (note the agent uses `set_page_title`, not `change_page_slug`, because you said *rename*; see `CLAUDE.md` for the three-identifier model)
- **Translation:** "the German variant of /about is stale, bring it up to date"
- **Plugin data:** "summarise the comments queue from this week — flag anything that looks like spam"
- **Configuration via propose/execute:** "propose adding French as a locale with subdirectory URL strategy" → the agent files the proposal at `/security/locales/pending`; you click Approve

## What it can't do

The chat-runner's actor scope still applies — the same set of operations the browser AI can't dispatch are blocked from MCP too:

- Locale config writes (admin-only at the validator)
- Plugin activation past `awaiting_activation` (Owner click required)
- Production deploy promotion (Ops human required)
- Anything else `CLAUDE.md` §2 forbids

When the agent attempts one of these it gets `ActorScopeRejected` and surfaces a "click here on your install to do this yourself" message in the response.

## Per-token cost cap

`mcp_tokens.ai_cost_cap_microcents` (set at mint time, editable later) bounds a leaked token's wallet impact. The chat-runner's pre-flight checks the cap before every provider call; exceeding it returns a `McpTokenCapExceeded` error.

## Token rotation

Tokens TTL out at **90 days** by default. Mint a new one, paste the new `claude mcp add` snippet, revoke the old one at `/security/mcp` → "Revoke". Next call with the revoked bearer returns `auth_error: token revoked`.

## What's NOT exposed

- **HTTP transport** — v1 ships stdio only (the universal MCP transport every client supports). HTTP transport is wired in the package but not in the docs path; that's for hosting Caelo as a multi-tenant MCP service which is a P18+ concern.
- **Direct ops access** — no `caelo_pages_list`, `caelo_publish`, etc. Conversational only.
- **Tools added by Tier 2 plugins** — Tier 2 plugins can't register chat-runner tools (locked SDK), so they can't appear in the MCP surface. Tier 1 tools the AI can dispatch are reachable through `caelo_chat`.

## Further reading

- The [`@caelo-cms/mcp-server` README](https://github.com/caelo-cms/caelo-cms/tree/main/packages/mcp-server) — the source of truth for the SDK shape
- [Architecture →](/architecture)
