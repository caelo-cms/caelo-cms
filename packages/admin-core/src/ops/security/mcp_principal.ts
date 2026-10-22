// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — one principal for every MCP request, however it
 * authenticated.
 *
 * Two credentials reach the `mcp.*` ops:
 *
 * - a bearer token (`plaintextToken`) — the stdio shim's `/api/mcp/*` REST
 *   calls; resolved by {@link resolveMcpToken} (mcp_tokens);
 * - a remote credential (`remote`) — the IAP assertion of a request to
 *   `/api/mcp/remote/<surface>`, re-verified here (never trusted from the
 *   caller) and mapped to the user's `mcp_remote_connections` row.
 *
 * Both resolve to the same {@link McpPrincipal} (`resolveMcpPrincipal` in
 * mcp_tokens.ts, next to the token lookup), so the op bodies are shared
 * and a remote agent gets byte-identical behaviour (actor, scope, cost cap,
 * AI delegation, attribution) to a token agent. Failures keep the
 * `auth_error:` / `permission_denied:` prefixes the HTTP shells map to
 * 401 / 403.
 *
 * Remote rows are one per (user, surface, client app) since #968, keyed by
 * the app the gateway names (mcp_credential.ts `client`). A row is
 * auto-created on the app's first request when the user may use the
 * surface (chat: `content.write`; admin: `settings.write`, what minting an
 * admin-scope token takes). A revoked row is sticky: a later request never
 * resurrects it — only the Owner's Restore does. An Owner's block
 * (`mcp_remote_access_blocks`) refuses every app of the user, new ones
 * included. docs/dev/mcp-access.md is the concept.
 */

import type { DatabaseAdapter, TransactionRunner } from "@caelo-cms/query-api";
import {
  describeMcpClient,
  err,
  MCP_SURFACE_COPY,
  MCP_SURFACE_PERMISSION,
  ok,
  type Result,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { recordAudit, SYSTEM_ACTOR_ID } from "../../audit.js";
import type { Permission } from "../../permissions.js";
import { iapVerifier } from "../../security/iap-assertion.js";
import type { McpAgentRef } from "../chat/mcp-agent.js";
import type { McpRemoteCredential, McpRemoteSurface } from "./mcp_credential.js";
import type { McpTokenScope } from "./mcp_tokens.js";

/** Who an MCP request acts as, whichever way it authenticated. */
export interface McpPrincipal {
  readonly actorId: string;
  /** Token scope, or the remote connection's surface. */
  readonly scope: McpTokenScope;
  readonly aiCostCapMicrocents: number | null;
  /** #741 — the agent may spend the install's own AI (Power-MCP only). */
  readonly allowCaeloAi: boolean;
  /** Names the external agent in the operator's UI (token label / client + email). */
  readonly displayName: string;
  readonly via:
    | { readonly kind: "token"; readonly tokenId: string }
    | {
        readonly kind: "remote";
        readonly connectionId: string;
        /** The Power-MCP work session of this connection (stateless transport). */
        readonly currentChatSessionId: string | null;
      };
}

/** The attribution ref of a principal (running agents, paused approvals). */
export function mcpAgentRefOf(principal: McpPrincipal): McpAgentRef {
  return principal.via.kind === "token"
    ? { kind: "token", tokenId: principal.via.tokenId }
    : { kind: "remote", connectionId: principal.via.connectionId };
}

/**
 * Why a remote request was refused. `status` is the HTTP status the remote
 * route answers with; `code` is the structured error the client reads.
 */
export interface RemoteMcpRefusal {
  readonly status: 400 | 401 | 403 | 503;
  readonly code:
    | "remote_mcp_not_configured"
    | "missing_iap_assertion"
    | "invalid_iap_assertion"
    | "missing_client_identity"
    | "not_a_caelo_user"
    | "permission_denied"
    | "remote_access_blocked"
    | "remote_access_revoked";
  readonly message: string;
}

/** What each remote surface requires of the user (see the module header). */
export const REMOTE_SURFACE_PERMISSION: Readonly<Record<McpRemoteSurface, Permission>> =
  MCP_SURFACE_PERMISSION;

/** Where an Owner manages remote connections, as the refusals name it. */
const SETTINGS_PLACE = "Settings → MCP → Remote connections";

const NOT_A_CAELO_USER =
  "This Google account has no access to this Caelo site. Ask the site Owner to add you under Settings → Users.";

/**
 * A request that reached the remote endpoint without the gateway naming
 * its client app: it did not come through `/api/mcp/<surface>`. The route
 * passes the client as `""` then, and the resolver answers this after IAP.
 */
const MISSING_CLIENT_IDENTITY: RemoteMcpRefusal = {
  status: 400,
  code: "missing_client_identity",
  message:
    "This request did not come through the site's MCP address, so Caelo cannot tell which app sent it. Connect your AI tool to the /api/mcp/chat or /api/mcp/admin URL shown under Settings → MCP.",
};

/**
 * The permission refusal, naming what is missing, the user's roles and the
 * roles that would allow it — the user can then ask for exactly that.
 */
function permissionMessage(
  surface: McpRemoteSurface,
  userRoles: readonly string[],
  allowingRoles: readonly string[],
): string {
  const permission = REMOTE_SURFACE_PERMISSION[surface];
  const yours =
    userRoles.length > 0
      ? `Your role (${userRoles.join(", ")}) does not grant it`
      : "Your role does not grant it";
  const allowing =
    allowingRoles.length > 0
      ? `; roles that do: ${allowingRoles.join(", ")}`
      : "; no role on this site grants it yet";
  const alternative =
    surface === "admin"
      ? " Connect the chat address (/api/mcp/chat) instead, or ask the site Owner to change your role under Settings → Users."
      : " Ask the site Owner to change your role under Settings → Users.";
  return `"${MCP_SURFACE_COPY[surface].title}" (/api/mcp/${surface}) needs the ${permission} permission. ${yours}${allowing}.${alternative}`;
}

const fmtDate = (v: string | Date): string =>
  (v instanceof Date ? v : new Date(v)).toISOString().slice(0, 10);

function revokedMessage(clientKey: string, by: string | null, at: string | Date): string {
  const who = by ? `by ${by}` : "by an Owner";
  return `Remote access for ${describeMcpClient(clientKey)} on this account was revoked ${who} on ${fmtDate(at)}. Your other connected apps are not affected. An Owner restores it under ${SETTINGS_PLACE}.`;
}

function legacyRevokedMessage(by: string | null, at: string | Date): string {
  const who = by ? `by ${by}` : "by an Owner";
  return `Remote access for this account was revoked ${who} on ${fmtDate(at)}, before Caelo told connected apps apart. Reconnect this app (remove and add the connector again) so it identifies itself; if the revocation was meant for another app, this one then works. An Owner restores access under ${SETTINGS_PLACE}.`;
}

function blockedMessage(by: string | null, at: string | Date): string {
  const who = by ? `by ${by}` : "by an Owner";
  return `Remote MCP access for this account is blocked for every app, ${who} on ${fmtDate(at)}. An Owner lifts the block under ${SETTINGS_PLACE}.`;
}

interface ConnectionRow {
  id: string;
  ai_cost_cap_microcents: bigint | string | number | null;
  allow_caelo_ai: boolean;
  current_chat_session_id: string | null;
  client_label: string | null;
  revoked_at: string | Date | null;
  revoked_by_email: string | null;
}

function toCap(v: bigint | string | number | null): number | null {
  if (v === null) return null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return Number.parseInt(v, 10);
  return v;
}

async function selectConnection(
  tx: TransactionRunner,
  actorId: string,
  surface: McpRemoteSurface,
  clientKey: string,
): Promise<ConnectionRow | undefined> {
  const rows = (await tx.execute(sql`
    SELECT c.id::text AS id, c.ai_cost_cap_microcents, c.allow_caelo_ai,
           c.current_chat_session_id::text AS current_chat_session_id, c.client_label,
           c.revoked_at, u.email AS revoked_by_email
    FROM mcp_remote_connections c
    LEFT JOIN users u ON u.id = c.revoked_by
    WHERE c.actor_id = ${actorId}::uuid AND c.surface = ${surface} AND c.client_key = ${clientKey}
    FOR UPDATE OF c
  `)) as unknown as ConnectionRow[];
  return rows[0];
}

/**
 * The pre-#968 row of (user, surface) becomes this app's row when the app's
 * MCP `initialize` names the client that row last saw — "the row of its
 * last client" (migration 0339). Its revocation, cap and work session carry
 * over; an app with another name never inherits them.
 */
async function adoptLegacyRow(
  tx: TransactionRunner,
  actorId: string,
  surface: McpRemoteSurface,
  clientKey: string,
  clientLabel: string | undefined,
): Promise<boolean> {
  if (clientLabel === undefined) return false;
  const adopted = (await tx.execute(sql`
    UPDATE mcp_remote_connections SET client_key = ${clientKey}
    WHERE actor_id = ${actorId}::uuid AND surface = ${surface}
      AND client_key IS NULL AND client_label = ${clientLabel}
    RETURNING id::text AS id
  `)) as unknown as { id: string }[];
  return adopted.length === 1;
}

interface LegacyRow {
  ai_cost_cap_microcents: bigint | string | number | null;
  allow_caelo_ai: boolean;
  revoked_at: string | Date | null;
  revoked_by_email: string | null;
}

/** The unclaimed pre-#968 row of (user, surface), if any. */
async function selectLegacyRow(
  tx: TransactionRunner,
  actorId: string,
  surface: McpRemoteSurface,
): Promise<LegacyRow | undefined> {
  const rows = (await tx.execute(sql`
    SELECT c.ai_cost_cap_microcents, c.allow_caelo_ai, c.revoked_at, u.email AS revoked_by_email
    FROM mcp_remote_connections c
    LEFT JOIN users u ON u.id = c.revoked_by
    WHERE c.actor_id = ${actorId}::uuid AND c.surface = ${surface} AND c.client_key IS NULL
  `)) as unknown as LegacyRow[];
  return rows[0];
}

/**
 * Verify a remote request's IAP assertion and resolve (auto-creating when
 * allowed) the user's connection for the request's surface and client app.
 * Not an op, like {@link resolveMcpToken}: the credential would otherwise
 * reach audit input.
 *
 * @param clientLabel - the MCP client's self-reported name (initialize
 *   `clientInfo`), stored for the Settings list when given, and the key
 *   that hands a pre-#968 row to its app.
 */
export async function resolveRemoteMcpPrincipal(
  adapter: DatabaseAdapter,
  credential: McpRemoteCredential,
  opts: { readonly clientLabel?: string } = {},
): Promise<Result<McpPrincipal, RemoteMcpRefusal>> {
  const verified = await iapVerifier()(credential.iapCredential);
  if (!verified.ok) {
    const e = verified.error;
    if (e.kind === "not_configured") {
      return err({ status: 503, code: "remote_mcp_not_configured", message: e.message });
    }
    if (e.kind === "missing") {
      return err({ status: 401, code: "missing_iap_assertion", message: e.message });
    }
    console.warn(`[mcp-remote] IAP assertion rejected: ${e.detail}`);
    return err({ status: 401, code: "invalid_iap_assertion", message: e.message });
  }
  const { email } = verified.identity;
  const { surface, client: clientKey } = credential;
  if (clientKey === "") return err(MISSING_CLIENT_IDENTITY);
  const label = opts.clientLabel?.trim().slice(0, 200) || undefined;

  return adapter.withAdminTransaction(
    { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: "mcp-resolve-remote" },
    async (tx): Promise<Result<McpPrincipal, RemoteMcpRefusal>> => {
      const permission = REMOTE_SURFACE_PERMISSION[surface];
      // Case-insensitive: Google normalises the address it asserts, the
      // Owner typed the Caelo user's. A deleted or role-less user is no
      // user of this site.
      const users = (await tx.execute(sql`
        SELECT u.id::text AS id, u.email,
               ARRAY(
                 SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                 WHERE ur.user_id = u.id ORDER BY r.name
               ) AS roles,
               EXISTS (
                 SELECT 1 FROM user_roles ur
                 JOIN role_permissions rp ON rp.role_id = ur.role_id
                 JOIN permissions p ON p.id = rp.permission_id
                 WHERE ur.user_id = u.id AND p.name = ${permission}
               ) AS allowed,
               b.blocked_at, bu.email AS blocked_by_email
        FROM users u
        LEFT JOIN mcp_remote_access_blocks b ON b.actor_id = u.id
        LEFT JOIN users bu ON bu.id = b.blocked_by
        WHERE lower(u.email) = lower(${email}) AND u.deleted_at IS NULL
      `)) as unknown as {
        id: string;
        email: string;
        roles: string[];
        allowed: boolean;
        blocked_at: string | Date | null;
        blocked_by_email: string | null;
      }[];
      // Two live users differing only in case cannot be told apart by the
      // assertion; refuse rather than guess.
      const user = users.length === 1 ? users[0] : undefined;
      if (!user || user.roles.length === 0) {
        return err({ status: 403, code: "not_a_caelo_user", message: NOT_A_CAELO_USER });
      }
      if (!user.allowed) {
        const allowing = (await tx.execute(sql`
          SELECT r.name FROM roles r
          JOIN role_permissions rp ON rp.role_id = r.id
          JOIN permissions p ON p.id = rp.permission_id
          WHERE p.name = ${permission} ORDER BY r.name
        `)) as unknown as { name: string }[];
        return err({
          status: 403,
          code: "permission_denied",
          message: permissionMessage(
            surface,
            user.roles,
            allowing.map((r) => r.name),
          ),
        });
      }
      if (user.blocked_at !== null) {
        return err({
          status: 403,
          code: "remote_access_blocked",
          message: blockedMessage(user.blocked_by_email, user.blocked_at),
        });
      }

      let row = await selectConnection(tx, user.id, surface, clientKey);
      if (!row && (await adoptLegacyRow(tx, user.id, surface, clientKey, label))) {
        row = await selectConnection(tx, user.id, surface, clientKey);
      }
      if (!row) {
        // An unclaimed pre-#968 row still speaks for this user's apps until
        // its own app claims it. A request that does not name its client
        // (no MCP initialize — e.g. a client resuming after the upgrade) may
        // be that very app, so it must not slip past the old revocation by
        // getting a fresh row; once it initializes, adoption decides. Any
        // new row starts with the old row's cap and AI delegation, so a
        // per-user limit the Owner set is not lost either.
        const legacy = await selectLegacyRow(tx, user.id, surface);
        if (legacy?.revoked_at && label === undefined) {
          return err({
            status: 403,
            code: "remote_access_revoked",
            message: legacyRevokedMessage(legacy.revoked_by_email, legacy.revoked_at),
          });
        }
        await tx.execute(sql`
          INSERT INTO mcp_remote_connections
            (actor_id, surface, client_key, ai_cost_cap_microcents, allow_caelo_ai)
          VALUES (${user.id}::uuid, ${surface}, ${clientKey},
                  ${legacy ? toCap(legacy.ai_cost_cap_microcents) : null},
                  ${legacy?.allow_caelo_ai === true})
          ON CONFLICT (actor_id, surface, client_key) DO NOTHING
        `);
        row = await selectConnection(tx, user.id, surface, clientKey);
        if (!row) {
          throw new Error("mcp_remote_connections insert returned no row");
        }
        await recordAudit(tx, {
          actorId: user.id,
          requestId: "mcp-resolve-remote",
          operation: "mcp_remote_connections.create",
          input: { surface, client: clientKey },
          succeeded: true,
          entityId: row.id,
          resultSummary: `first remote MCP request on ${surface} from ${describeMcpClient(clientKey)}`,
        });
      }
      if (row.revoked_at !== null) {
        return err({
          status: 403,
          code: "remote_access_revoked",
          message: revokedMessage(clientKey, row.revoked_by_email, row.revoked_at),
        });
      }
      await tx.execute(sql`
        UPDATE mcp_remote_connections
        SET last_used_at = now(), client_label = COALESCE(${label ?? null}, client_label)
        WHERE id = ${row.id}::uuid
      `);
      return ok({
        actorId: user.id,
        scope: surface,
        aiCostCapMicrocents: toCap(row.ai_cost_cap_microcents),
        allowCaeloAi: row.allow_caelo_ai === true,
        displayName: `${describeMcpClient(clientKey)} · ${user.email}`,
        via: {
          kind: "remote",
          connectionId: row.id,
          currentChatSessionId: row.current_chat_session_id,
        },
      });
    },
  );
}
