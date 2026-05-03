// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — owner_bootstrap_tokens. cms-provision generates a single-use,
 * 24h-TTL token; the first user redeems it at /setup?token=<…>. Without
 * a valid token, /setup refuses to create the first owner — closes the
 * "anyone who reaches the fresh install can claim it" hole.
 *
 * Two ops:
 *  - `owner_bootstrap_tokens.insert` — system-only, hooks.server.ts calls
 *    this once at startup if it finds `.caelo/pending-token.json` left
 *    by the CLI (cms-provision init).
 *  - `owner_bootstrap_tokens.consume` — system-only, /setup calls this
 *    inside the same request as users.create_first_owner; on success
 *    the row is marked used.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit, SYSTEM_ACTOR_ID } from "../audit.js";

const tokenShape = z.string().regex(/^[0-9a-f]{64}$/);

export const insertBootstrapTokenOp = defineOperation({
  name: "owner_bootstrap_tokens.insert",
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({
    token: tokenShape,
    expiresAt: z.string().datetime(),
  }),
  output: z.object({ inserted: z.boolean() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      INSERT INTO owner_bootstrap_tokens (token, expires_at)
      VALUES (${input.token}, ${input.expiresAt}::timestamptz)
      ON CONFLICT (token) DO NOTHING
      RETURNING token
    `)) as unknown as { token: string }[];
    const inserted = rows.length > 0;
    await recordAudit(tx, {
      actorId: SYSTEM_ACTOR_ID,
      requestId: ctx.requestId,
      operation: "owner_bootstrap_tokens.insert",
      input: { tokenPrefix: input.token.slice(0, 8) },
      succeeded: true,
      resultSummary: inserted ? "inserted" : "already-present",
    });
    return ok({ inserted });
  },
});

/**
 * Consume a token. Returns ok({valid:true}) only if the token exists,
 * has not been used, and has not expired. Atomic: marks used_at in the
 * same statement so two concurrent /setup posts cannot both succeed.
 *
 * Caller is responsible for setting used_by AFTER the first owner row
 * is created (see users.create_first_owner_with_token).
 */
export const consumeBootstrapTokenOp = defineOperation({
  name: "owner_bootstrap_tokens.consume",
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({
    token: tokenShape,
  }),
  output: z.object({ valid: z.boolean() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE owner_bootstrap_tokens
      SET used_at = now()
      WHERE token = ${input.token}
        AND used_at IS NULL
        AND expires_at > now()
      RETURNING token
    `)) as unknown as { token: string }[];
    const valid = rows.length > 0;
    await recordAudit(tx, {
      actorId: SYSTEM_ACTOR_ID,
      requestId: ctx.requestId,
      operation: "owner_bootstrap_tokens.consume",
      input: { tokenPrefix: input.token.slice(0, 8) },
      succeeded: valid,
      resultSummary: valid ? "consumed" : "rejected",
    });
    if (!valid) {
      return err({
        kind: "HandlerError",
        operation: "owner_bootstrap_tokens.consume",
        message: "token invalid, expired, or already used",
      });
    }
    return ok({ valid: true });
  },
});

/**
 * Has any token ever been issued? Used by /setup to decide whether to
 * require ?token=. On a brand-new install where the CLI was never run
 * (e.g. `bun run dev` straight from a checkout), zero tokens exist and
 * /setup falls back to the unauthenticated path (developer ergonomics).
 * Once any token is issued, /setup hard-requires one.
 */
export const anyBootstrapTokenIssuedOp = defineOperation({
  name: "owner_bootstrap_tokens.any_issued",
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({}),
  output: z.object({ anyIssued: z.boolean() }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(
      sql`SELECT EXISTS(SELECT 1 FROM owner_bootstrap_tokens) AS any_issued`,
    )) as unknown as { any_issued: boolean }[];
    return ok({ anyIssued: rows[0]?.any_issued ?? false });
  },
});
