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
[docs page](https://caelo-cms.com/mcp) for the full Power-MCP working
model (work sessions, preview branches, approval gates).

## Install

In your Caelo install:

1. Visit `/security/mcp` as an Owner.
2. Click **New token**, give it a name (`claude-code`, `laptop`, `ci`,
   etc.), optionally set an AI-spend cap (microcents), and copy the
   bearer that's shown ONCE.
3. The page renders the exact `claude mcp add` snippet — copy + run it.
   For `admin` tokens it also shows the optional `export` command (see
   below).

The snippet pins the package to your admin's version
(`@caelo-cms/mcp-server@<admin-version>`). Keep it pinned: an unpinned
`bunx @caelo-cms/mcp-server` resolves `@latest` once and then serves that
cached copy indefinitely, so after a Caelo upgrade the server can lag
behind the admin (e.g. a pre-IAP-support version against an IAP-protected
admin fails with `Invalid IAP credentials: empty token`). After upgrading
Caelo, re-add the server with the new version.

Manual setup if your client isn't Claude Code:

```bash
# stdio server invoked by your MCP-aware client — use your admin's version
bunx @caelo-cms/mcp-server@<admin-version>                                   # caelo_chat
bunx --package @caelo-cms/mcp-server@<admin-version> caelo-admin-mcp         # Power-MCP
```

with these env vars set:

| Variable | Required | Notes |
|---|---|---|
| `CAELO_ADMIN_URL` | yes | `https://admin.example.com` — point at your install. |
| `CAELO_MCP_TOKEN` | yes | Bearer minted at `/security/mcp`. |
| `CAELO_IAP_SERVICE_ACCOUNT` | on GCP installs | The admin's MCP service account. `/security/mcp` includes it in the `claude mcp add` command when the admin is behind Google IAP. |

### Installs behind Google IAP (GCP)

On `gcp` and `gcp-firebase` installs the admin sits behind Identity-Aware Proxy, which rejects every request before Caelo sees it unless it carries a Google credential. With `CAELO_IAP_SERVICE_ACCOUNT` set, the server signs a short-lived JWT as that service account (IAM Credentials `signJwt`, using your Application Default Credentials) and sends it in `Authorization` next to `x-caelo-mcp-token`: IAP checks the first, Caelo the second.

One-time setup on your machine:

```bash
gcloud auth application-default login
```

The provisioner creates the service account (`caelo-mcp@<project>`), allowlists it on IAP and lets everyone on the IAP allowlist sign as it — on new installs via Pulumi, on existing ones during `cms-provision upgrade`. No service-account keys are involved.

## Getting the agent started

Both servers send MCP `instructions` in their initialize result, which
Claude Code (and other clients) put into the model's context on connect.
The Power-MCP instructions tell the agent to call `caelo_open_session`
first (every catalogue tool fails without an open session), then
`caelo_get_context` (site model, staging rules, brand voice, skills
index), then `load_skill` for every ALWAYS APPLIES skill and every skill
matching the task. You don't have to explain any of this to the agent.

For a persistent, checked-in context (admin token required):

```bash
CAELO_ADMIN_URL=… CAELO_MCP_TOKEN=… \
  bunx --package @caelo-cms/mcp-server@<admin-version> caelo-mcp-server export --out .
```

writes `CLAUDE.md` + `.claude/skills/<slug>/SKILL.md` into the directory;
re-run after skills or site memory change.

## The `caelo_chat` tool

| Field | Type | Notes |
|---|---|---|
| `message` | string, required | What you want to say to the Caelo agent. |
| `chatSessionId` | uuid, optional | Continue an existing chat session. |
| `attachments` | array, optional | Up to four image references returned by `caelo_upload_images`. |
| `pageId` | uuid, optional | Bind a NEW chat to one page so the agent's page-context block populates. |

Output: assistant reply text + a JSON block with `chatSessionId` (for
the next call), `requestId` (click through to
`/security/audit/<requestId>` for the full audit trail), the structured
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

The token owner's current `content.write` permission is required for either scope. Images are stored in the shared CMS media library; admin previews require authentication. Uploading alone does not publish a page. A partial batch keeps successful uploads — retry only the failed entries. See the [upload workflow](https://caelo-cms.com/mcp#upload-and-attach-images) for HTTP examples and server limits.
