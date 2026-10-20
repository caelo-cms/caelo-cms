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
 * Remote rows are auto-created on a user's first request on a surface when
 * the user may use it (chat: `content.write`; admin: `settings.write`, what
 * minting an admin-scope token takes). A revoked row is sticky: a later
 * request never resurrects it — only the Owner's Restore does.
 */

import type { DatabaseAdapter, TransactionRunner } from "@caelo-cms/query-api";
import { err, ok, type Result } from "@caelo-cms/shared";
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
  readonly status: 401 | 403 | 503;
  readonly code:
    | "remote_mcp_not_configured"
    | "missing_iap_assertion"
    | "invalid_iap_assertion"
    | "not_a_caelo_user"
    | "permission_denied"
    | "remote_access_revoked";
  readonly message: string;
}

/** What each remote surface requires of the user (see the module header). */
export const REMOTE_SURFACE_PERMISSION: Readonly<Record<McpRemoteSurface, Permission>> = {
  chat: "content.write",
  admin: "settings.write",
};

const NOT_A_CAELO_USER =
  "This Google account has no access to this Caelo site. Ask the site Owner to add you under Settings → Users.";

const PERMISSION_MESSAGE: Readonly<Record<McpRemoteSurface, string>> = {
  chat:
    "Remote caelo_chat needs the content.write permission, which your Caelo role does not grant. " +
    "Ask the site Owner for an editing role under Settings → Users.",
  admin:
    "The remote Power-MCP surface (/api/mcp/admin) needs the settings.write permission — the same an admin-scoped MCP token needs. " +
    "Connect to the chat surface (/api/mcp/chat) instead, or ask the site Owner for the permission under Settings → Users.",
};

const REVOKED_MESSAGE =
  "Remote access for this account was revoked under Settings → MCP. Ask the site Owner to restore it there.";

interface ConnectionRow {
  id: string;
  ai_cost_cap_microcents: bigint | string | number | null;
  allow_caelo_ai: boolean;
  current_chat_session_id: string | null;
  client_label: string | null;
  revoked_at: string | Date | null;
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
): Promise<ConnectionRow | undefined> {
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, ai_cost_cap_microcents, allow_caelo_ai,
           current_chat_session_id::text AS current_chat_session_id, client_label, revoked_at
    FROM mcp_remote_connections
    WHERE actor_id = ${actorId}::uuid AND surface = ${surface}
    FOR UPDATE
  `)) as unknown as ConnectionRow[];
  return rows[0];
}

/**
 * Verify a remote request's IAP assertion and resolve (auto-creating when
 * allowed) the user's connection on `surface`. Not an op, like
 * {@link resolveMcpToken}: the credential would otherwise reach audit input.
 *
 * @param clientLabel - the MCP client's self-reported name (initialize
 *   `clientInfo`), stored for the Settings list when given.
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
  const surface = credential.surface;

  return adapter.withAdminTransaction(
    { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: "mcp-resolve-remote" },
    async (tx): Promise<Result<McpPrincipal, RemoteMcpRefusal>> => {
      // Case-insensitive: Google normalises the address it asserts, the
      // Owner typed the Caelo user's. A deleted or role-less user is no
      // user of this site.
      const users = (await tx.execute(sql`
        SELECT u.id::text AS id, u.email,
               EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id) AS has_role,
               EXISTS (
                 SELECT 1 FROM user_roles ur
                 JOIN role_permissions rp ON rp.role_id = ur.role_id
                 JOIN permissions p ON p.id = rp.permission_id
                 WHERE ur.user_id = u.id AND p.name = ${REMOTE_SURFACE_PERMISSION[surface]}
               ) AS allowed
        FROM users u
        WHERE lower(u.email) = lower(${email}) AND u.deleted_at IS NULL
      `)) as unknown as { id: string; email: string; has_role: boolean; allowed: boolean }[];
      // Two live users differing only in case cannot be told apart by the
      // assertion; refuse rather than guess.
      const user = users.length === 1 ? users[0] : undefined;
      if (!user?.has_role) {
        return err({ status: 403, code: "not_a_caelo_user", message: NOT_A_CAELO_USER });
      }
      if (!user.allowed) {
        return err({
          status: 403,
          code: "permission_denied",
          message: PERMISSION_MESSAGE[surface],
        });
      }

      let row = await selectConnection(tx, user.id, surface);
      if (!row) {
        await tx.execute(sql`
          INSERT INTO mcp_remote_connections (actor_id, surface)
          VALUES (${user.id}::uuid, ${surface})
          ON CONFLICT (actor_id, surface) DO NOTHING
        `);
        row = await selectConnection(tx, user.id, surface);
        if (!row) {
          throw new Error("mcp_remote_connections insert returned no row");
        }
        await recordAudit(tx, {
          actorId: user.id,
          requestId: "mcp-resolve-remote",
          operation: "mcp_remote_connections.create",
          input: { surface },
          succeeded: true,
          entityId: row.id,
          resultSummary: `first remote MCP request on ${surface}`,
        });
      }
      if (row.revoked_at !== null) {
        return err({ status: 403, code: "remote_access_revoked", message: REVOKED_MESSAGE });
      }
      const label = opts.clientLabel?.trim().slice(0, 200) || null;
      await tx.execute(sql`
        UPDATE mcp_remote_connections
        SET last_used_at = now(), client_label = COALESCE(${label}, client_label)
        WHERE id = ${row.id}::uuid
      `);
      const clientLabel = label ?? row.client_label;
      return ok({
        actorId: user.id,
        scope: surface,
        aiCostCapMicrocents: toCap(row.ai_cost_cap_microcents),
        allowCaeloAi: row.allow_caelo_ai === true,
        displayName: clientLabel ? `${clientLabel} · ${user.email}` : user.email,
        via: {
          kind: "remote",
          connectionId: row.id,
          currentChatSessionId: row.current_chat_session_id,
        },
      });
    },
  );
}
