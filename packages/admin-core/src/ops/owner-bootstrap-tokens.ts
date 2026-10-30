// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — owner_bootstrap_tokens. cms-provision generates a single-use,
 * 24h-TTL token; the first user redeems it at /setup?token=<…>. Without
 * a valid token, /setup refuses to create the first owner — closes the
 * "anyone who reaches the fresh install can claim it" hole.
 *
 * Ops:
 *  - `owner_bootstrap_tokens.insert` — system-only, hooks.server.ts calls
 *    this once at startup if it finds `.caelo/pending-token.json` left
 *    by the CLI (cms-provision init).
 *  - `owner_bootstrap_tokens.any_issued` — whether /setup must ask for one.
 *
 * Redeeming a token is NOT an op of its own: `users.create_first_owner`
 * marks it used inside its own transaction, after its other checks, so a
 * rejected setup attempt never burns the single-use token (PR #863).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit, SYSTEM_ACTOR_ID } from "../audit.js";

const tokenShape = z.string().regex(/^[0-9a-f]{64}$/);

export const insertBootstrapTokenOp = defineOperation({
  name: "owner_bootstrap_tokens.insert",
  readScope: "request",
  // Why system-only: a bootstrap token is the credential that creates the first Owner; only the
  // provisioning/boot path may mint one.
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
 * Has any token ever been issued? Used by /setup to decide whether to
 * require ?token=. On a brand-new install where the CLI was never run
 * (e.g. `bun run dev` straight from a checkout), zero tokens exist and
 * /setup falls back to the unauthenticated path (developer ergonomics).
 * Once any token is issued, /setup hard-requires one.
 */
export const anyBootstrapTokenIssuedOp = defineOperation({
  name: "owner_bootstrap_tokens.any_issued",
  readScope: "request",
  // Why system-only: /setup's unauthenticated pre-check; there is no caller identity yet.
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
