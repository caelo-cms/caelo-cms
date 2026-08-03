---
slug: mcp
template: doc-page
locale: en
status: published
seo:
  title: Talk to Caelo from your IDE — MCP servers
  description: Drive your Caelo install from Claude Code, Cursor, or any MCP-aware client. Two surfaces — caelo_chat (Caelo's own AI does the work) and the admin-scoped Power-MCP (your agent drives the full tool catalogue).
---

# Talk to Caelo from your IDE — MCP servers

`@caelo-cms/mcp-server` connects your Caelo install to Claude Code (or any [Model Context Protocol](https://modelcontextprotocol.io)–aware client) — without opening the browser. It ships **two surfaces**, selected by the token's scope:

- **`caelo_chat`** (token scope `chat`) — one tool that talks to Caelo's **own** AI agent. You describe an outcome; Caelo's chat-runner reasons and does the work. The simplest integration: anyone can wire it up and say "build me a pricing page".
- **Power-MCP** (token scope `admin`, binary `caelo-admin-mcp`) — the **full chat-runner tool catalogue** exposed directly, so *your* agent (e.g. Claude Code) drives the tool loop itself. Caelo makes **no provider calls** on this path — the reasoning happens (and is billed) in your own agent. For tool-heavy work like site migrations this cuts the install's AI cost to near zero.

Both surfaces share the same bearer-token model, the same audit trail, and the same security invariants.

## The chat surface: `caelo_chat`

The browser chat is one consumer of the chat-runner; `caelo_chat` is another. The remote client talks to a human-equivalent agent, not to a programmatic API:

- "Which pages exist?" → the agent calls `pages.list` internally → answer in text
- "Publish the draft" → the agent invokes the publish op (or asks you to confirm a hard-to-revert change)
- "What's waiting for my approval?" → the agent surfaces `pendingProposals` in every response

### Install

1. As Owner, navigate to `/security/mcp`
2. Click **New token**, scope `chat`, give it a name, optionally set an AI-spend cap in microcents (USD × 10⁸), and copy the bearer that's shown ONCE
3. The page renders the exact `claude mcp add` snippet — copy + run it

```bash
claude mcp add caelo --command "bunx @caelo-cms/mcp-server" \
  --env CAELO_ADMIN_URL=https://your-install.example.com \
  --env CAELO_MCP_TOKEN=mcp_<32-bytes-hex>
```

### The tool

| Field | Type | Notes |
|---|---|---|
| `message` | string, required | What you want to say to the Caelo agent |
| `chatSessionId` | UUID, optional | Continue an existing chat session |
| `pageId` | UUID, optional | Bind a NEW chat to one page so the agent's page-context block populates |

Output: the assistant's reply text + a JSON block with `chatSessionId`, `requestId`, `toolCalls`, `pendingProposals`, `costMicrocents`. `requestId` is your click-through to `/security/audit/<requestId>` for the full audit trail.

## The Power-MCP surface: your agent, Caelo's tools

Where `caelo_chat` hands your intent to Caelo's AI, the Power-MCP hands your **agent** Caelo's tools — the same ~140-tool catalogue the chat-runner uses (`build_page`, `edit_module`, `set_page_module_content`, `bulk_create_redirects`, `import_media_from_urls`, …), each with its full description and JSON schema. Your agent plans, reasons, and loops; Caelo executes one tool per call.

Because the executing context is identical to a chat turn, **every invariant carries over automatically**:

- **AI actor.** Calls run as an AI actor bound to the token's owner. An external model is an AI actor no matter who runs it — human-only ops stay unreachable, and actor-scope gates apply unchanged.
- **Preview branch.** Every call runs inside a work session (a chat session). Writes land on its preview branch, invisible to the live site until the operator reviews and publishes in the admin — publishing is not exposed to the agent.
- **Snapshots + undo.** Every write emits a snapshot grouped under the session, so chat-keyed undo works exactly as if the work had happened in the browser chat.
- **Approval gates.** `propose_*` tools queue an Owner proposal ("Queued proposal `<uuid>`…") in the per-domain pending queue at `/security/<domain>/pending` — the agent is told to say "I prepared this — click Approve", and cannot apply it itself.

### Install

Mint a token with scope **`admin`** at `/security/mcp`, then:

```bash
claude mcp add caelo-admin --command "bunx --package @caelo-cms/mcp-server caelo-admin-mcp" \
  --env CAELO_ADMIN_URL=https://your-install.example.com \
  --env CAELO_MCP_TOKEN=mcp_<32-bytes-hex>
```

(`caelo-mcp-server admin` is the same server; the separate binary keeps the snippet flag-free.)

### Working model

Two meta-tools frame every Power-MCP session:

1. **`caelo_open_session`** — call once before any other tool. Opens (or, with `chatSessionId`, resumes) the work session whose preview branch all subsequent calls write to.
2. **`caelo_get_context`** — the composed site context Caelo's own AI gets in its system prompt: the module model, the tool playbook, staging rules, site memory, and the active-skills index. Load it once; load individual skills on demand via the regular `load_skill` tool.

Then work with the catalogue directly. Tool failures come back AI-actionable (naming valid choices and next steps), the same error surfaces Caelo's own agent self-corrects from.

### Feeding Claude Code the site context

For a checked-in variant of `caelo_get_context`, run:

```bash
CAELO_ADMIN_URL=… CAELO_MCP_TOKEN=… bunx @caelo-cms/mcp-server export --out .
```

This writes a `CLAUDE.md` plus one `.claude/skills/<slug>/SKILL.md` per active skill into the working directory — Claude Code picks both up automatically at session start. Re-run the export after skills or site memory change.

### Not exposed over Power-MCP

A handful of tools only make sense inside Caelo's own loop and are filtered out (calling them anyway returns the reason + the routing alternative): `spawn_subagent`/`spawn_subagents` (your agent brings its own parallelism), `screenshot_page` (needs the operator's browser; use `inspect_built_page` / `inspect_page_render`), `offer_choices`, `submit_result`.

## Token scopes, caps, rotation

- **Scopes.** `chat` drives `caelo_chat` only. `admin` additionally unlocks the Power-MCP endpoints. Existing tokens stay `chat`; using one against the Power-MCP returns a 401 naming the fix.
- **Cost cap.** `ai_cost_cap_microcents` (set at mint time) bounds a leaked token's wallet impact. On the chat surface the runner checks it during the turn (`cost cap reached: spent ~N µ¢ / cap M µ¢`); on the Power-MCP it gates the tools that make their own provider calls (`generate_image`, `query_page_html`, translation) against the session's accumulated spend. To change a cap, mint a replacement token and revoke the old one.
- **Rotation.** Tokens TTL out at **90 days** by default. Mint a new one, paste the new snippet, revoke the old at `/security/mcp`. The next call with a revoked bearer returns `auth_error: token revoked`.

## What's NOT exposed

- **HTTP transport** — both servers are stdio only (the universal MCP transport every client supports). Hosting Caelo as a remote multi-tenant MCP service is a later concern.
- **Publishing over Power-MCP** — the agent stages; the operator reviews and publishes in the admin. Same split as the browser chat.
- **Tools added by Tier 2 plugins** — Tier 2 plugins can't register chat-runner tools (locked SDK). Tier 1 plugin tools appear in both surfaces.

## Further reading

- The [`@caelo-cms/mcp-server` README](https://github.com/caelo-cms/caelo-cms/tree/main/packages/mcp-server) — the source of truth for the SDK shape
- [Architecture →](/architecture)
