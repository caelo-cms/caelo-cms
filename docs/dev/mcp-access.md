# MCP access

How people connect AI tools to a Caelo site over MCP (Model Context Protocol), who may connect what, and what an Owner controls. This is the concept for issue #968; the mechanics of each piece live in the code it names.

## The three access paths

| Path | Address | Who signs in, and how | For |
|---|---|---|---|
| **Remote chat** | `https://<site>/api/mcp/chat` | Each person, with their own Google account (OAuth through the MCP-Auth-Proxy's broker, then Google IAP) | ChatGPT, claude.ai, Claude Code, Cursor, VS Code, Gemini CLI, … asking **this site's AI** to do the work (`caelo_chat`) |
| **Remote Power** (Power-MCP, #376) | `https://<site>/api/mcp/power` | Same | An external agent that does the work **itself** with every tool Caelo's AI has |
| **Token** | the local MCP server (stdio) + `/api/mcp/*` | A bearer token each person mints for themselves under Settings → MCP | Tools that run Caelo's MCP server on a computer, CI jobs, and installs without remote MCP (self-hosted, AWS, Azure) |

Remote MCP exists only on the Google Cloud installs (`gcp`, `gcp-firebase`), because Google IAP is the gate (CLAUDE.md §11.B). It is on exactly when the install's Google sign-in client is set up (Settings → Google sign-in, #914). There is no separate switch.

### Decisions (#968)

- **Tokens stay, for local tools only.** A tool that can connect by URL should, because remote MCP needs no secret on anyone's machine and follows the person's role and account. Tokens remain the path for stdio, CI and installs without IAP. Everyone who may work through an AI sees the token section and mints their own (see "Tokens act as their minter"). A person who lost that permission but still holds a token sees it, so they can revoke it.
- **Members only see the addresses they may use.** Since #1636 that is both or neither, except on an install without an AI key, where the chat address is off for everyone. An address nobody could use is not offered: it only produces a confusing failure.
- **One connection per client app**, described below.

## Who may use which surface

| Surface | Needs | Default roles |
|---|---|---|
| chat | `content.write` | owner, editor |
| power | `content.write` | owner, editor |

**One permission for working through an AI (#1636).** Sending a turn in the Live Edit chat, the chat surface and the Power surface all need `AI_WORK_PERMISSION` (`content.write`, `packages/shared/src/mcp-access.ts`). It is one rule because it is one thing: on every path an AI actor bound to the person runs the same tool catalogue (the Power surface leaves out four tools that need the chat's own loop) in the site's draft, and every approval-gated tool queues a card that only someone holding the action's own permission can approve (`requiresApproverPermission`, CLAUDE.md §11.A). An editor's agent can therefore propose what an editor's chat can propose, and nothing more. Until #1636 the Power surface needed `settings.write`, a rule carried over from minting tokens; it kept out the people the surface suits best, those who bring their own AI subscription, although it is the path that spends none of the install's AI by default.

What stays with the Owner (`settings.write`): setting up remote MCP, the cost cap and "may use Caelo's AI" of a connection or token, revoke, restore and block, and seeing other people's connections and tokens.

The rule lives in one place: `MCP_SURFACE_PERMISSION` reads `AI_WORK_PERMISSION`, and the chat's stream route, the resolver (`packages/admin-core/src/ops/security/mcp_principal.ts`), token resolution, Settings → MCP and the MCP-Auth-Proxy's consent page all read those, so the code, the UI and the error messages cannot drift apart. `scripts/ai-work-permission.test.ts` fails when a path uses another permission.

### The name

The surface was called `admin` until #1636 (`/api/mcp/admin`, scope `admin`, "Full admin access", `caelo-admin-mcp`). It gives no admin rights, so it is `power` now, the name the first-run wizard and Settings → AI already used ("Power-MCP"). Three things outside the repo still hold the old name, and each keeps working until 1.0 (#1638), declared in one place (`LEGACY_POWER_SURFACE_NAME`):

| Where | Old | How it keeps working |
|---|---|---|
| A connector's URL, and the OAuth tokens sealed for it | `/api/mcp/admin` | The MCP-Auth-Proxy answers it as an address of its own (`MCP_ADDRESSES`) and forwards it to the admin's `/api/mcp/remote/admin`, a second entry to the Power surface. The connection row is marked (`via_legacy_address`), and Settings → MCP shows "old address" until the connector is added again with the new URL. |
| Stored rows | `mcp_tokens.scope = 'admin'`, `mcp_remote_connections.surface = 'admin'` | Everything written since stores `power`; reads take both spellings (`mcp_credential.ts`). No row is rewritten, so the previous release keeps running on the schema (migration 0700). |
| Client configs | `caelo-admin-mcp`, `caelo-mcp-server admin` | Both stay entries to the same server. The other way round, a shim started as `caelo-power-mcp` against an install from before the rename re-runs that release under the old name: the admin's version answer lists the programs its release ships (`bins`), and a missing list means the old ones (`reexecTarget`, `packages/mcp-server/src/version-handshake.ts`). |

On `gcp` the Cloud Armor rule for the MCP paths names the addresses. A path it does not name is still served (the proxy's policy has no other rule, and the proxy rate-limits every route itself), so the new address works before an install's next converge adds it to the rule; no contract bump (`packages/provisioning/src/remote-mcp-edge.ts`).

### Tokens act as their minter

`mcp_tokens.create` stores the caller as the token's actor. A token an Owner hands to a teammate is therefore the Owner: attribution, audit and plugin-tool permission checks all read "Owner". So everyone who may work through an AI mints their own token (the op checks `AI_WORK_PERMISSION`; RLS 0315 limits a non-Owner to their own rows), and an approved `propose_create_mcp_token` card mints a token that acts as whoever approved it. Only an Owner can turn on "may use Caelo's AI" for a token, because that spends the install's AI.

A person without the permission gets `403 permission_denied` on their first MCP request. The message names the address, the missing permission, the person's roles and the roles that would allow it.

The check cannot happen before OAuth completes. The broker learns who signed in only at `/token`: Google's code exchange needs the client's PKCE verifier, and only the client has it. Even then, the broker holds no admin credential to look up the person's role. So the consent page states up front which permission each address needs, and the first MCP request answers with the exact refusal.

## Connections

A **connection** is one row in `mcp_remote_connections`: one person, one surface, one client app. It is what an Owner sees and controls under Settings → MCP → Connected apps. It is the remote counterpart of an `mcp_tokens` row in attribution: running agents, paused approval cards and audit name it.

### The client app's identity

The MCP-Auth-Proxy's OAuth broker knows which app it issued a grant to. `mcpClientKey` (`apps/mcp-auth-proxy/src/access-token.ts`) turns that into a stable key:

- **CIMD** clients (ChatGPT, claude.ai, Claude Code): the client metadata document URL, e.g. `https://chatgpt.com/oauth/client.json`.
- **DCR** clients: `dcr:<client_name>`. The DCR `client_id` itself is a fresh seal per registration, and clients register again whenever they lose their cached registration, so keying by the id would turn every re-registration into a new connection.
- **DCR without a name**: `dcr:` plus a hash of the registration.

The key is sealed into the access token next to the surface (RFC 8707 resource). The proxy forwards it to the admin as `x-caelo-mcp-client`. An inbound `x-caelo-*` header never passes the proxy's allowlist, so a client cannot claim another app's identity through the proxy, and a stolen token stays bound to its app.

**What the key is not.** It is not a security boundary against the person themselves. The key comes from a self-chosen name (DCR registration is open), and a person who calls the IAP-protected admin directly can send any value. Both only ever pick that person's own rows, and the key grants nothing: IAP and the person's Caelo role decide access. Revoking one app is for "this app should stop", not for cutting off a person. That is what the block is for.

### Revoke, restore, block

| Action | Scope | Effect |
|---|---|---|
| Revoke | one app (row) | That app's next request gets `403 remote_access_revoked`. It is sticky: no request recreates it. The person's other apps keep working. The message names who revoked it, when, and where to restore it. |
| Restore | one app (row) | Lifts the revocation. |
| Block all apps | one person | Every remote request of that person is refused (`403 remote_access_blocked`), including apps they connect later. Individual revocations are kept. Stored in `mcp_remote_access_blocks`. |
| Unblock | one person | Lifts the block. Apps revoked one by one stay revoked. |
| Cost cap / "may use Caelo's AI" | one app (row) | Same semantics as a token's (#741). "May use Caelo's AI" applies only to the Power surface. |

Removing the person under Settings → Users (or taking away their role) ends all their access, tokens and remote, within IAP's propagation time.

Only an Owner (`settings.write`) and system change connections and blocks. This is enforced by RLS (migrations 0322, 0339), not only by the route. Everyone else sees their own rows read-only. The AI never reads or writes either table (the ops are `human` + `system`).

### Rows from before per-app connections

Migration 0339 keeps existing rows with `client_key IS NULL`. The first app whose MCP `initialize` reports the same client name as the row's `client_label` takes the row over. The row's revocation, cap and work session carry over to "its last client". Any other app gets a row of its own. That is the case the per-app model fixes: a revoked "Claude Code" row no longer locks out ChatGPT. Until the row is claimed, it still constrains the user's other apps on that surface:
- A new app's row starts with the old row's cap and AI delegation.
- If the old row is revoked, a request that does not identify its app (no MCP `initialize`, for example a client resuming after the upgrade) is refused with a "reconnect this app" message. That request might come from the revoked app itself. Reconnecting makes the app identify itself, and adoption then decides.

The MCP-Auth-Proxy fixes an app's key at sign-in and carries it in the sealed refresh token. A refresh never recomputes it, so rotating the seal key cannot turn a revoked DCR app into a new, active connection.

## No AI key: Power-MCP only (#1460)

An install works fully without an AI key of its own: an external agent on the Power surface does the reasoning and the AI work on its own subscription. This is a stored choice of the Owner, not an absent provider row read as a mode (CLAUDE.md §2).

- **The state.** One row in `mcp_only_mode` (migration 0620) means the Owner chose it. `ai_providers.get_mode` reads `mcp_only`, `provider` or `unset` (`InstallAiMode`, `packages/shared/src/install-ai-mode.ts`). The first-run wizard (`/welcome/ai`) preselects this option and writes it with `ai_providers.set_mcp_only` (human-only, audited, refused while a usable key exists); no provider row is written. The table is exempt from the change journal, like `ai_providers`.
- **How it ends.** `ai_providers.set` removes the row in its own transaction once an active provider has a usable key, and a key pasted in this mode activates its provider, so a key under Settings → AI ends the mode with no further step and no restart. Removing the last key does not switch the mode on: the install goes back to `unset`, and the wizard asks again.
- **The resolver is the gate.** While the row exists nothing resolves, neither the environment's key nor a provider cached on another instance (checked before the cache in `provider-resolver.ts`). So every caller's "no provider" path holds, and the callers that word a refusal ask `isMcpOnlyInstall()`.
- **MCP.** Both credential paths read the row with the principal: `principal.noInstallAi` is true and `principal.allowCaeloAi` is false whatever the token or connection stores. Every call is therefore AI-delegated (#741): work items for the agent where they exist, `AiDelegated:` otherwise. `caelo_get_context` says so in `## AI work on this connection` and in the status line.
- **The chat surface is off.** A chat token cannot be minted or proposed (`mcp_tokens.create`, `mcp_tokens.propose_create`), `mcp.send_chat` refuses with `NoInstallAi:`, and Settings → MCP and its Remote page offer only the Power surface and say why. Chat tokens and connections from before keep their rows and work again once a key is stored.
- **Live Edit.** The composer gives way to a notice with links to Settings → AI and Settings → MCP, and `ChatPanel` starts no turn (no first-run welcome, no quality fix offer). The stream endpoint refuses with `code: "no_install_ai"`. Preview, Stage, Publish live and approval cards are untouched: the cards are how an agent's gated tools get their human click.
- **Every caller has a defined result.** `scripts/install-ai-callers.test.ts` pins the inventory of the resolver's callers with what each does here, and no background worker is among them, so nothing logs on a timer for a state the Owner chose. Plugin AI on a human path (a panel's "let the AI decide") refuses with `NoInstallAi:`, which names both ways forward.

## The Claude Code plugins (#975, #1637)

The marketplace at the repo root (`.claude-plugin/marketplace.json`) lists two plugins. Both bring the same skills (`connect`, `edit-site`, `handover`) and differ in how they connect:

| Plugin | Directory | Connects | For |
|---|---|---|---|
| `caelo` | `integrations/claude-code` | by URL: one remote server at the address the person enters (`mcp_url`), signed in with Google through `/mcp` | Google Cloud installs with remote MCP |
| `caelo-token` | `integrations/claude-code-token` | Caelo's local MCP server (`caelo-power-mcp`) with a token | self-hosted, AWS, Azure, CI |

The URL plugin is the default, because a tool that can connect by URL should (see the #968 decisions): no secret on anyone's machine, each person is themselves, no Bun, no gcloud, and no package to pin, since the install serves its own release. It holds no code and no address; `scripts/claude-plugin.test.ts` pins that its one server entry is `{ "type": "http", "url": "${user_config.mcp_url}" }` and nothing else.

**Why two plugins and not one with two servers.** Measured with Claude Code 2.1.326 and a throwaway plugin (2026-11-17), because the docs do not say what happens to a plugin server whose option is empty:

- A remote server whose URL option is empty is listed as failed: "URL is unset or invalid — open /plugin manage and configure …". It is not skipped.
- The local server without credentials starts and is listed as connected (#841, so directories can list its tools), with every call failing.
- With the URL set, Claude Code starts OAuth discovery for the plugin's server like for any remote server (protected-resource metadata, then registration).

So one plugin with both servers would show every person a second Caelo server that does not work: a failed one in token mode, and a connected one that doubles the tool list with tools that all fail in URL mode. Each plugin asks only for what its path needs instead.

The shared skills are two files kept identical in both directories (a `git-subdir` source fetches only its own directory, so they cannot be shared by path); the same test fails when they differ, and when one of them names a plugin option, because the skills also load in claude.ai and Cowork, where the connection is a custom connector.

Settings → MCP → Remote shows the install commands for `caelo` on its Claude Code tab for the Power address (`claudePluginInstallCommands`), before the bare `claude mcp add`.

## Settings → MCP

On an install without an AI key the page leads with creating a token and the `claude mcp add` command (see above). Otherwise it is state-aware:

1. **Connect AI tools by URL.** Not available: why, and that tokens are the path. Needs upgrade: the provisioner step. Off: "Set up remote MCP" (Owner) or "ask an Owner". On: "Remote MCP is on" and, for each address this person may use, what it does, who may use it, the URL and a suggested connector name (`Caelo viu.one (Chat)`, `Caelo viu.one (Power)`) so two connectors in one AI tool stay apart. It never offers "set up" once remote MCP is on. Settings → MCP → Remote has the step-by-step setup per AI tool.
2. **Connected apps.** Grouped by person, one row per app and address: status (who revoked it, when), last used, cap, revoke/restore, and "old address" for an app that still connects through `/api/mcp/admin`. Owners also get "Block all apps".
3. **Token access for local tools.** Everyone who may work through an AI (their own tokens; an Owner sees all), plus anyone who still holds a token.

## Invariants (#376, #806)

- **IAP is the gate.** No MCP request reaches the admin without IAP. The MCP-Auth-Proxy holds no admin credential and forwards only the person's own Google ID token (#806).
- **External agents are AI actors.** Every write from either surface runs as an `ai` actor on a chat session's preview branch. Nothing reaches the live site until a person publishes. Approval-gated tools pause for a click in the Caelo admin, never in the AI tool, and only someone holding the action's own permission can make it (CLAUDE.md §11.A).
- **One work session per agent (#1253).** `caelo_open_session` without arguments always opens a NEW chat in the shared draft, marked as an agent chat of its client (`chat_sessions.agent_client`). It never resumes the operator's own chat; `chatSessionId` continues a named one. The chat list groups agent chats per client, and Live Edit never picks one as the operator's chat. Undo, Stop and presence are each agent's own.
- **Which session a call runs in.** A call's own `workSessionId` argument wins (the Power-MCP surface adds it to every catalogue tool and strips it before dispatch), so sub-agents sharing one connection keep their own sessions. Otherwise: the stdio shim's last opened session (process memory), or, on the stateless remote transport, the session bound to the client's MCP transport session. The admin mints `Mcp-Session-Id` on `initialize`; `caelo_open_session` binds it in `mcp_transport_sessions` (0453), scoped to the connection row, so a made-up header names only the caller's own mappings. A client that sends no `Mcp-Session-Id` (one connected before 0.11.6) cannot carry a bound session: `caelo_open_session` then says so and tells it to pass `workSessionId` on every call (or reconnect), and remembers the session in `mcp_unbound_work_sessions` (0481), so a later call without one is refused with that session's id instead of "open a session first" (#1306).
- **No per-chat write slot.** A Power-MCP write takes no turn lease. Concurrent writes to one entity conflict per entity: across chats by the draft's owner check (#620), and against the version the call read — the database snapshot `mcp.begin_tool_call` takes (`tool-call-version.ts`, `chat_entity_locks.last_write_xid`, 0454). Two calls of one session that edit one entity at once therefore get a re-read conflict, never a silent overwrite.
- **Per-call cost.** The remote route resolves the principal once per request with plain reads (no `FOR UPDATE`); `last_used_at` of a connection or token is written at most once a minute. A tool call then costs two transactions of its own (`mcp.begin_tool_call`, `mcp.finish_tool_call`) besides the tool's ops; presence and `last_active_at` are renewed only when 30 s stale. The approval wait polls with the resolved principal. The `tools/call` JSON-RPC id plus the transport session (or the shim's process) is the idempotency key, so a repeated request returns the first result.
- **Attribution.** Running agents and paused approvals name exactly one token or one connection (`chat_agent_runs`, `chat_turn_approvals`). Audit and the cost dashboard show the app and the person.
- **The AI cannot widen access.** Token and connection management is human/system only. The AI's token lifecycle tools are approval-gated proposals, and a token minted that way acts as the person who approved it.
