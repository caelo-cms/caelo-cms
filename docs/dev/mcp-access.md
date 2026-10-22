# MCP access

How people connect AI tools to a Caelo site over MCP (Model Context Protocol), who may connect what, and what an Owner controls. This is the concept for issue #968; the mechanics of each piece live in the code it names.

## The three access paths

| Path | Address | Who signs in, and how | For |
|---|---|---|---|
| **Remote chat** | `https://<site>/api/mcp/chat` | Each person, with their own Google account (OAuth through the gateway's broker, then Google IAP) | ChatGPT, claude.ai, Claude Code, Cursor, VS Code, Gemini CLI, … asking **this site's AI** to do the work (`caelo_chat`) |
| **Remote admin** (Power-MCP, #376) | `https://<site>/api/mcp/admin` | Same | An external agent that does the work **itself** with every tool Caelo's AI has |
| **Token** | the local MCP server (stdio) + `/api/mcp/*` | A bearer token an Owner mints under Settings → MCP | Tools that run Caelo's MCP server on a computer, CI jobs, and installs without remote MCP (self-hosted, AWS, Azure) |

Remote MCP exists only on the Google Cloud installs (`gcp`, `gcp-firebase`), because Google IAP is the gate (CLAUDE.md §11.B). It is on exactly when the install's Google sign-in client is set up (Settings → Google sign-in, #914). There is no separate switch.

### Decisions (#968)

- **Tokens stay, for local tools only.** A tool that can connect by URL should, because remote MCP needs no secret on anyone's machine and follows the person's role and account. Tokens remain the path for stdio, CI and installs without IAP. Only roles that may mint tokens (`settings.write`) see the token section. A person who still holds a token of their own sees it, so they can revoke it.
- **Members only see the addresses they may use.** Settings → MCP shows an editor the chat address and one line saying full admin access is for roles that may change settings. It does not show the admin URL. The admin address is not secret (anyone can guess `/api/mcp/admin`, and the role check refuses them), but offering it to someone who cannot use it only produces a confusing failure.
- **One connection per client app**, described below.

## Who may use which surface

| Surface | Needs | Default roles |
|---|---|---|
| chat | `content.write` | owner, editor |
| admin | `settings.write` (what minting an admin-scoped token needs) | owner |

The rule lives in one place: `MCP_SURFACE_PERMISSION` in `packages/shared/src/mcp-access.ts`. The resolver (`packages/admin-core/src/ops/security/mcp_principal.ts`), Settings → MCP and the gateway's consent page all read it, so the code, the UI and the error messages cannot drift apart.

A person without the permission gets `403 permission_denied` on their first MCP request. The message names the address, the missing permission, the person's roles and the roles that would allow it.

The check cannot happen before OAuth completes. The broker learns who signed in only at `/token`: Google's code exchange needs the client's PKCE verifier, and only the client has it. Even then, the broker holds no admin credential to look up the person's role. So the consent page states up front which permission each address needs, and the first MCP request answers with the exact refusal.

## Connections

A **connection** is one row in `mcp_remote_connections`: one person, one surface, one client app. It is what an Owner sees and controls under Settings → MCP → Connected apps. It is the remote counterpart of an `mcp_tokens` row in attribution: running agents, paused approval cards and audit name it.

### The client app's identity

The gateway's OAuth broker knows which app it issued a grant to. `mcpClientKey` (`apps/api-gateway/src/mcp/access-token.ts`) turns that into a stable key:

- **CIMD** clients (ChatGPT, claude.ai, Claude Code): the client metadata document URL, e.g. `https://chatgpt.com/oauth/client.json`.
- **DCR** clients: `dcr:<client_name>`. The DCR `client_id` itself is a fresh seal per registration, and clients register again whenever they lose their cached registration, so keying by the id would turn every re-registration into a new connection.
- **DCR without a name**: `dcr:` plus a hash of the registration.

The key is sealed into the access token next to the surface (RFC 8707 resource). The proxy forwards it to the admin as `x-caelo-mcp-client`. An inbound `x-caelo-*` header never passes the proxy's allowlist, so a client cannot claim another app's identity through the gateway, and a stolen token stays bound to its app.

**What the key is not.** It is not a security boundary against the person themselves. The key comes from a self-chosen name (DCR registration is open), and a person who calls the IAP-protected admin directly can send any value. Both only ever pick that person's own rows, and the key grants nothing: IAP and the person's Caelo role decide access. Revoking one app is for "this app should stop", not for cutting off a person. That is what the block is for.

### Revoke, restore, block

| Action | Scope | Effect |
|---|---|---|
| Revoke | one app (row) | That app's next request gets `403 remote_access_revoked`. It is sticky: no request recreates it. The person's other apps keep working. The message names who revoked it, when, and where to restore it. |
| Restore | one app (row) | Lifts the revocation. |
| Block all apps | one person | Every remote request of that person is refused (`403 remote_access_blocked`), including apps they connect later. Individual revocations are kept. Stored in `mcp_remote_access_blocks`. |
| Unblock | one person | Lifts the block. Apps revoked one by one stay revoked. |
| Cost cap / "may use Caelo's AI" | one app (row) | Same semantics as a token's (#741). "May use Caelo's AI" applies only to the admin surface. |

Removing the person under Settings → Users (or taking away their role) ends all their access, tokens and remote, within IAP's propagation time.

Only an Owner (`settings.write`) and system change connections and blocks. This is enforced by RLS (migrations 0322, 0339), not only by the route. Everyone else sees their own rows read-only. The AI never reads or writes either table (the ops are `human` + `system`).

### Rows from before per-app connections

Migration 0339 keeps existing rows with `client_key IS NULL`. The first app whose MCP `initialize` reports the same client name as the row's `client_label` takes the row over. The row's revocation, cap and work session carry over to "its last client". Any other app gets a row of its own. That is the case the per-app model fixes: a revoked "Claude Code" row no longer locks out ChatGPT. Until the row is claimed, it still constrains the user's other apps on that surface:
- A new app's row starts with the old row's cap and AI delegation.
- If the old row is revoked, a request that does not identify its app (no MCP `initialize`, for example a client resuming after the upgrade) is refused with a "reconnect this app" message. That request might come from the revoked app itself. Reconnecting makes the app identify itself, and adoption then decides.

The gateway fixes an app's key at sign-in and carries it in the sealed refresh token. A refresh never recomputes it, so rotating the seal key cannot turn a revoked DCR app into a new, active connection.

## Settings → MCP

The page is state-aware:

1. **Connect AI tools by URL.** Not available: why, and that tokens are the path. Needs upgrade: the provisioner step. Off: "Set up remote MCP" (Owner) or "ask an Owner". On: "Remote MCP is on" and, for each address this person may use, what it does, who may use it, the URL and a suggested connector name (`Caelo viu.one (Chat)`, `Caelo viu.one (Admin)`) so two connectors in one AI tool stay apart. It never offers "set up" once remote MCP is on. Settings → MCP → Remote has the step-by-step setup per AI tool.
2. **Connected apps.** Grouped by person, one row per app and address: status (who revoked it, when), last used, cap, revoke/restore. Owners also get "Block all apps".
3. **Token access for local tools.** Owners, plus anyone who still holds a token.

## Invariants (#376, #806)

- **IAP is the gate.** No MCP request reaches the admin without IAP. The gateway holds no admin credential and forwards only the person's own Google ID token (#806).
- **External agents are AI actors.** Every write from either surface runs as an `ai` actor on a chat session's preview branch. Nothing reaches the live site until a person publishes. Approval-gated tools pause for an Owner's click in the Caelo admin, never in the AI tool (CLAUDE.md §11.A).
- **One work session per connection.** The remote transport is stateless, so the Power-MCP "current session" lives on the connection row (`current_chat_session_id`). Per-app rows mean two apps of one person no longer share, and fight over, one session.
- **Attribution.** Running agents and paused approvals name exactly one token or one connection (`chat_agent_runs`, `chat_turn_approvals`). Audit and the cost dashboard show the app and the person.
- **The AI cannot widen access.** Token and connection management is human/system only. The AI's token lifecycle tools are approval-gated proposals.
