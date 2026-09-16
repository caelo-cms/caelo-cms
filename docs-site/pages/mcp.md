---
slug: mcp
template: doc-page
status: published
seo:
  title: Talk to Caelo from your IDE — MCP servers
  description: Drive your Caelo install from Claude Code, Cursor, or any MCP-aware client. Two surfaces — caelo_chat (Caelo's own AI does the work) and the admin-scoped Power-MCP (your agent drives the full tool catalogue).
---

# Talk to Caelo from your IDE — MCP servers

`@caelo-cms/mcp-server` connects your Caelo install to Claude Code (or any [Model Context Protocol](https://modelcontextprotocol.io)–aware client) — without opening the browser. It ships **two surfaces**, selected by the token's scope:

- **`caelo_chat`** (token scope `chat`) — talks to Caelo's **own** AI agent. You describe an outcome; Caelo's chat-runner reasons and does the work. The simplest integration: anyone can wire it up and say "build me a pricing page".
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
claude mcp add caelo \
  --env CAELO_ADMIN_URL=https://your-install.example.com \
  --env CAELO_MCP_TOKEN=mcp_<32-bytes-hex> \
  -- bunx @caelo-cms/mcp-server
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
claude mcp add caelo-admin \
  --env CAELO_ADMIN_URL=https://your-install.example.com \
  --env CAELO_MCP_TOKEN=mcp_<32-bytes-hex> \
  -- bunx --package @caelo-cms/mcp-server caelo-admin-mcp
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

A handful of tools only make sense inside Caelo's own loop and are filtered out (calling them anyway returns the reason + the routing alternative): `spawn_subagent`/`spawn_subagents` (your agent brings its own parallelism), `offer_choices`, `submit_result`. `screenshot_page` IS served: on this surface it renders the session branch's preview in server-side Chromium and returns the pixels as an MCP image content block.

## Token scopes, caps, rotation

- **Scopes.** `chat` drives `caelo_chat` and image uploads. `admin` additionally unlocks the Power-MCP endpoints. Existing tokens stay `chat`; using one against the Power-MCP returns a 401 naming the fix.
- **Cost cap.** `ai_cost_cap_microcents` (set at mint time) bounds a leaked token's wallet impact. On the chat surface the runner checks it during the turn (`cost cap reached: spent ~N µ¢ / cap M µ¢`); on the Power-MCP it gates the tools that make their own provider calls (`generate_image`, `query_page_html`) against the session's accumulated spend. To change a cap, mint a replacement token and revoke the old one.
- **Rotation.** Tokens TTL out at **90 days** by default. Mint a new one, paste the new snippet, revoke the old at `/security/mcp`. The next call with a revoked bearer returns `auth_error: token revoked`.

## What's NOT exposed

- **HTTP transport** — both servers are stdio only (the universal MCP transport every client supports). Hosting Caelo as a remote multi-tenant MCP service is a later concern.
- **Publishing over Power-MCP** — the agent stages; the operator reviews and publishes in the admin. Same split as the browser chat.
- **Tools added by Tier 2 plugins** — Tier 2 plugins can't register chat-runner tools (locked SDK). Tier 1 plugin tools appear in both surfaces.

## Further reading

- The [`@caelo-cms/mcp-server` README](https://github.com/caelo-cms/caelo-cms/tree/main/packages/mcp-server) — the source of truth for the SDK shape
- [Architecture →](/architecture)

## Upload and attach images

Both MCP modes expose `caelo_upload_images`. Supply 1–4 images, each at most **5 MiB**. PNG, JPEG, WebP and GIF are supported. Uploading uses the token owner's current `content.write` permission; revoked or expired tokens and deleted users cannot upload.

For a local file, pass its path **on the machine running the MCP server**:

```json
{
  "images": [
    { "filePath": "/home/me/Pictures/character.png", "alt": "Reference for the main character" }
  ]
}
```

Call `caelo_upload_images` with that input. If the image is available as bytes instead, replace `filePath` with `base64` (raw base64, without a `data:` prefix) and optionally provide `filename`. Do not supply both. File paths are read by the local MCP process, never by the Caelo server.

The result contains an `attachments` array and a `results` entry for each input file. Successful uploads survive other files failing; retry only the failed entries. Pass the returned `attachments` unchanged to `caelo_chat` together with your message and optional `chatSessionId`. The model receives image content, and the images remain part of the persisted chat history. In admin mode, use the returned asset IDs with the regular media/page tools.

Uploads go into the shared **media library**. Admin preview URLs require authentication; uploaded images can subsequently be used on published pages. Uploading alone does not publish a page. Removing an attachment from the composer does not delete the media asset. Use the media library to manage or delete it.

A non-MCP HTTP client can use the same authenticated endpoint:

```sh
curl --fail-with-body "$CAELO_ADMIN_URL/api/mcp/images?filename=character.png" \
  -H "x-caelo-mcp-token: $CAELO_MCP_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @./character.png
```

The response supplies `assetId`, the server-detected `mime`, and `deduped`. To attach it to a chat, send `{ "message": "Use this character", "attachments": [{ "assetId": "<returned UUID>", "mime": "<returned MIME>" }] }` to `POST /api/mcp/chat` with the same bearer header. Object-store keys are not accepted as MCP attachments.

In the browser chat, click **Add images**, paste an image, or drag files onto the composer. You can review and remove the thumbnails before sending; an image-only message is supported. Sending waits until all uploads finish. The same format and size limits apply.

Container releases set `BODY_SIZE_LIMIT=8M` to accommodate image uploads. When running the Bun build directly, set this environment variable too; reverse proxies must allow at least that request size. The image endpoint still enforces 5 MiB per file independently of the HTTP server limit.
