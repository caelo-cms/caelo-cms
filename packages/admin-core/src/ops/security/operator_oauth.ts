// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #914 — the install's Google sign-in client, as far as the database
 * knows it: the client ID only (migration 0323).
 *
 * One Owner-created Google OAuth client serves three uses: IAP browser login
 * (so accounts outside the project's Google organisation can sign in), IAP
 * programmatic access, and the remote-MCP broker (#806). Never a second one.
 *
 * The secret lives in Secret Manager, written by the admin's setup flow
 * (security/google-sign-in/configure.ts) and read by the gateway's broker
 * and the operator-access sync job. The ID is stored here for the sync job,
 * which sets the project's IAP `oauthSettings` to exactly this client
 * ({@link operatorOAuthClientForSyncOp}), for the setup pages, and for the
 * identity-gate check on user creation (security/identity-gate.ts).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { GOOGLE_OAUTH_CLIENT_ID, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit, SYSTEM_ACTOR_ID } from "../../audit.js";

/** `GOOGLE_OAUTH_CLIENT_ID` (shared, = the 0323 CHECK) as a trimmed Zod string with an operator-facing message. */
export const googleOAuthClientIdSchema = z
  .string()
  .trim()
  .regex(
    GOOGLE_OAUTH_CLIENT_ID,
    "a Google OAuth client ID looks like 123456789012-abc123def456.apps.googleusercontent.com",
  );

const clientRow = z.object({ clientId: z.string(), configuredAt: z.string() });

/** `operator_oauth.get` — the configured client, or null when Google sign-in is not set up. */
export const getOperatorOAuthClientOp = defineOperation({
  name: "operator_oauth.get",
  readScope: "request",
  // Why human-only: backs the Owner's Google sign-in and remote-MCP setup
  // pages; the client is credential configuration the AI neither sets nor
  // needs (the user-create guard reads the row inside its own op).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ client: clientRow.nullable() }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT client_id, configured_at FROM operator_oauth_client WHERE id
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

/** `operator_oauth.set` — record the client the Owner just stored in Secret Manager. */
export const setOperatorOAuthClientOp = defineOperation({
  name: "operator_oauth.set",
  readScope: "request",
  // Why human-only: decides which OAuth client Google IAP signs people in
  // with and accepts programmatically; it is set together with the client
  // secret, which the AI must never handle (CLAUDE.md §11.A credential rule).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ clientId: googleOAuthClientIdSchema }).strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const actorId = ctx.actorId ?? SYSTEM_ACTOR_ID;
    await tx.execute(sql`
      INSERT INTO operator_oauth_client (id, client_id, configured_by, configured_at)
      VALUES (true, ${input.clientId}, ${actorId}::uuid, now())
      ON CONFLICT (id) DO UPDATE
        SET client_id = EXCLUDED.client_id,
            configured_by = EXCLUDED.configured_by,
            configured_at = EXCLUDED.configured_at
    `);
    await recordAudit(tx, {
      actorId,
      requestId: ctx.requestId,
      operation: "operator_oauth.set",
      input: { clientId: input.clientId },
      succeeded: true,
      resultSummary: `Google sign-in client set to ${input.clientId}`,
    });
    return ok({});
  },
});

/** `operator_oauth.clear` — Google sign-in removed: IAP falls back to its Google-managed client. */
export const clearOperatorOAuthClientOp = defineOperation({
  name: "operator_oauth.clear",
  readScope: "request",
  // Why human-only: the Owner's "Remove" under Settings → Google sign-in,
  // after a warning naming who loses access; same credential surface as
  // operator_oauth.set.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ cleared: z.boolean() }),
  handler: async (ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      DELETE FROM operator_oauth_client WHERE id RETURNING client_id
    `)) as unknown as { client_id: string }[];
    await recordAudit(tx, {
      actorId: ctx.actorId ?? SYSTEM_ACTOR_ID,
      requestId: ctx.requestId,
      operation: "operator_oauth.clear",
      input: {},
      succeeded: true,
      resultSummary: rows[0] ? `Google sign-in client ${rows[0].client_id} removed` : "none set",
    });
    return ok({ cleared: rows.length > 0 });
  },
});

/**
 * `operator_oauth.client_for_sync` — the client ID the operator-access sync
 * job sets as IAP's `oauthSettings` (browser client + programmatic clients).
 * Selects only `client_id`: the job's `operator_access_reader` role may read
 * nothing else of the table (migration 0324).
 */
export const operatorOAuthClientForSyncOp = defineOperation({
  name: "operator_oauth.client_for_sync",
  readScope: "request",
  // Why system-only: the input of the operator-access sync job, which runs
  // as a system actor with a read-only database role.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({ clientId: z.string().nullable() }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT client_id FROM operator_oauth_client
    `)) as unknown as { client_id: string }[];
    return ok({ clientId: rows[0]?.client_id ?? null });
  },
});
