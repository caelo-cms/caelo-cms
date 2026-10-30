// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 PR 3 / #727 — the Owner's op behind the admin quality view
 * (/settings/quality):
 *
 *   quality_acceptances.revoke_many   the Owner takes acceptances back — one,
 *                                     or a whole bulk decision at once; each
 *                                     finding blocks on its page again.
 *
 * (#727 retired `quality_baselines.list`: the gate holds every page to 100
 * and keeps no per-page baselines.)
 */

import { defineOperation, OperationAbortError, uuidArray } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { actorHasPermission } from "./_permissions.js";

export const revokeAcceptancesOp = defineOperation({
  name: "quality_acceptances.revoke_many",
  readScope: "request",
  // Why human-only: #553 §5 — the Owner reviews and takes back what editors
  // accepted; an acceptance is a human decision and so is undoing it.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** Every acceptance to revoke (a bulk decision revokes in one call). */
      acceptanceIds: z.array(z.string().uuid()).min(1).max(20000),
      reason: z.string().trim().max(500).optional(),
    })
    .strict(),
  output: z.object({ revoked: z.number().int() }),
  handler: async (ctx, input, tx) => {
    // The Owner gate (settings.write), enforced here because the op has
    // no single route in front of it.
    if (!(await actorHasPermission(tx, ctx, "settings.write"))) {
      return err({
        kind: "HandlerError",
        operation: "quality_acceptances.revoke_many",
        message: "revoking an acceptance is an Owner decision (settings.write)",
      });
    }
    const ids = [...new Set(input.acceptanceIds)];
    const rows = (await tx.execute(sql`
      UPDATE quality_acceptances
         SET revoked_at = now(), revoked_by = ${ctx.actorId}::uuid
       WHERE id = ANY(${uuidArray(ids)}) AND revoked_at IS NULL
      RETURNING id::text AS id, kind, coalesce(audit_id, category) AS what
    `)) as unknown as { id: string; kind: string; what: string | null }[];
    if (rows.length !== ids.length) {
      // All or nothing: a stale selection (someone revoked meanwhile) must
      // not half-apply — the Owner reloads and decides on what is live.
      const live = new Set(rows.map((r) => r.id));
      const missing = ids.filter((id) => !live.has(id));
      throw new OperationAbortError({
        kind: "HandlerError",
        operation: "quality_acceptances.revoke_many",
        message: `${missing.length} acceptance(s) not found or already revoked (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}) — reload and choose again; nothing was revoked`,
      });
    }
    const what = [...new Set(rows.map((r) => `${r.kind} ${r.what ?? ""}`.trim()))];
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "quality_acceptances.revoke_many",
      input,
      succeeded: true,
      entityId: ids.length === 1 ? (ids[0] ?? null) : null,
      resultSummary: `revoked ${rows.length} acceptance(s): ${what.slice(0, 5).join(", ")}${what.length > 5 ? ", …" : ""}${input.reason ? ` — ${input.reason}` : ""}`,
    });
    return ok({ revoked: rows.length });
  },
});
