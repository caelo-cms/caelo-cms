// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — the Google OAuth client remote MCP signs users in with, as
 * far as the database knows it: the client ID only (migration 0313).
 *
 * The secret lives in Secret Manager, written by the admin's setup flow
 * (security/remote-mcp/setup.ts) and read only by the gateway's broker. The
 * ID is stored here for the operator-access sync job, which keeps the admin
 * IAP resource's `programmatic_clients` at exactly this client
 * ({@link mcpRemoteOAuthClientForSyncOp}), and for the setup page.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit, SYSTEM_ACTOR_ID } from "../../audit.js";

/**
 * A Google OAuth 2.0 client ID (`<project number>-<random>.apps.googleusercontent.com`).
 * Same pattern as the 0313 CHECK constraint.
 */
export const GOOGLE_OAUTH_CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

export const googleOAuthClientIdSchema = z
  .string()
  .trim()
  .regex(
    GOOGLE_OAUTH_CLIENT_ID,
    "a Google OAuth client ID looks like 123456789012-abc123def456.apps.googleusercontent.com",
  );

const clientRow = z.object({ clientId: z.string(), configuredAt: z.string() });

/** `mcp_remote_oauth.get` — the configured client, or null when remote MCP is not set up. */
export const getMcpRemoteOAuthClientOp = defineOperation({
  name: "mcp_remote_oauth.get",
  // Why human-only: backs the Owner's remote-MCP setup page; the client is
  // credential configuration the AI neither sets nor needs.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ client: clientRow.nullable() }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT client_id, configured_at FROM mcp_remote_oauth_client WHERE id
    `)) as unknown as { client_id: string; configured_at: string | Date }[];
    const r = rows[0];
    return ok({
      client: r
        ? {
            clientId: r.client_id,
            configuredAt:
              r.configured_at instanceof Date
                ? r.configured_at.toISOString()
                : String(r.configured_at),
          }
        : null,
    });
  },
});

/** `mcp_remote_oauth.set` — record the client the Owner just stored in Secret Manager. */
export const setMcpRemoteOAuthClientOp = defineOperation({
  name: "mcp_remote_oauth.set",
  // Why human-only: decides which OAuth client may call the IAP-protected
  // admin programmatically; it is set together with the client secret,
  // which the AI must never handle (CLAUDE.md §11.A credential rule).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ clientId: googleOAuthClientIdSchema }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const actorId = ctx.actorId ?? SYSTEM_ACTOR_ID;
    await tx.execute(sql`
      INSERT INTO mcp_remote_oauth_client (id, client_id, configured_by, configured_at)
      VALUES (true, ${input.clientId}, ${actorId}::uuid, now())
      ON CONFLICT (id) DO UPDATE
        SET client_id = EXCLUDED.client_id,
            configured_by = EXCLUDED.configured_by,
            configured_at = EXCLUDED.configured_at
    `);
    await recordAudit(tx, {
      actorId,
      requestId: ctx.requestId,
      operation: "mcp_remote_oauth.set",
      input: { clientId: input.clientId },
      succeeded: true,
      resultSummary: `remote MCP OAuth client set to ${input.clientId}`,
    });
    return ok({});
  },
});

/** `mcp_remote_oauth.clear` — remote MCP turned off: no client. */
export const clearMcpRemoteOAuthClientOp = defineOperation({
  name: "mcp_remote_oauth.clear",
  // Why human-only: the Owner's "Turn off remote MCP" in Settings → MCP;
  // same credential surface as mcp_remote_oauth.set.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ cleared: z.boolean() }),
  handler: async (ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      DELETE FROM mcp_remote_oauth_client WHERE id RETURNING client_id
    `)) as unknown as { client_id: string }[];
    await recordAudit(tx, {
      actorId: ctx.actorId ?? SYSTEM_ACTOR_ID,
      requestId: ctx.requestId,
      operation: "mcp_remote_oauth.clear",
      input: {},
      succeeded: true,
      resultSummary: rows[0] ? `remote MCP OAuth client ${rows[0].client_id} removed` : "none set",
    });
    return ok({ cleared: rows.length > 0 });
  },
});

/**
 * `mcp_remote_oauth.client_for_sync` — the client ID the operator-access
 * sync job allowlists in IAP `programmatic_clients`. Selects only
 * `client_id`: the job's `operator_access_reader` role may read nothing
 * else of the table (migration 0314).
 */
export const mcpRemoteOAuthClientForSyncOp = defineOperation({
  name: "mcp_remote_oauth.client_for_sync",
  // Why system-only: the input of the operator-access sync job, which runs
  // as a system actor with a read-only database role.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ clientId: z.string().nullable() }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT client_id FROM mcp_remote_oauth_client
    `)) as unknown as { client_id: string }[];
    return ok({ clientId: rows[0]?.client_id ?? null });
  },
});
