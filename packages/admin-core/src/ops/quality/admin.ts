// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #553 PR 3 — ops behind the admin quality view (/security/quality):
 *
 *   quality_baselines.list       the ratchet per page and category.
 *   quality_acceptances.revoke   the Owner takes an acceptance back; the
 *                                finding blocks again on its page.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";
import { INITIAL_BASELINE } from "../../quality/ratchet.js";
import { actorHasPermission } from "./_permissions.js";
import { categorySchema, iso } from "./_shared.js";

export const listBaselinesOp = defineOperation({
  name: "quality_baselines.list",
  // CLAUDE.md §11: read-only, open to every actor.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      pageId: z.string().uuid().optional(),
      /** Only categories whose baseline is below the 100 target. */
      belowTargetOnly: z.boolean().default(false),
      limit: z.number().int().min(1).max(1000).default(500),
    })
    .strict(),
  output: z.object({
    baselines: z.array(
      z.object({
        pageId: z.string(),
        pagePath: z.string(),
        category: categorySchema,
        baseline: z.number().int(),
        belowStreak: z.number().int(),
        updatedAt: z.string(),
      }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT b.page_id::text AS page_id, p.current_path, b.category, b.baseline, b.below_streak,
             b.updated_at
      FROM quality_baselines b JOIN pages p ON p.id = b.page_id AND p.deleted_at IS NULL
      WHERE TRUE
        ${input.pageId ? sql`AND b.page_id = ${input.pageId}::uuid` : sql``}
        ${input.belowTargetOnly ? sql`AND b.baseline < ${INITIAL_BASELINE}` : sql``}
      ORDER BY (p.current_path = '/') DESC, p.current_path, b.category
      LIMIT ${input.limit}
    `)) as unknown as {
      page_id: string;
      current_path: string;
      category: z.infer<typeof categorySchema>;
      baseline: number;
      below_streak: number;
      updated_at: string | Date;
    }[];
    return ok({
      baselines: rows.map((r) => ({
        pageId: r.page_id,
        pagePath: r.current_path,
        category: r.category,
        baseline: r.baseline,
        belowStreak: r.below_streak,
        updatedAt: iso(r.updated_at),
      })),
    });
  },
});

export const revokeAcceptanceOp = defineOperation({
  name: "quality_acceptances.revoke",
  // Why human-only: #553 §5 — the Owner reviews and takes back what editors
  // accepted; an acceptance is a human decision and so is undoing it.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      acceptanceId: z.string().uuid(),
      reason: z.string().trim().max(500).optional(),
    })
    .strict(),
  output: z.object({ revoked: z.boolean() }),
  handler: async (ctx, input, tx) => {
    // The Owner gate (settings.write), enforced here because the op has
    // no single route in front of it.
    if (!(await actorHasPermission(tx, ctx, "settings.write"))) {
      return err({
        kind: "HandlerError",
        operation: "quality_acceptances.revoke",
        message: "revoking an acceptance is an Owner decision (settings.write)",
      });
    }
    const rows = (await tx.execute(sql`
      UPDATE quality_acceptances
         SET revoked_at = now(), revoked_by = ${ctx.actorId}::uuid
       WHERE id = ${input.acceptanceId}::uuid AND revoked_at IS NULL
      RETURNING page_id::text AS page_id, kind, category, audit_id
    `)) as unknown as {
      page_id: string;
      kind: "finding" | "score";
      category: string | null;
      audit_id: string | null;
    }[];
    const row = rows[0];
    if (!row) {
      return err({
        kind: "HandlerError",
        operation: "quality_acceptances.revoke",
        message: `acceptance ${input.acceptanceId} not found or already revoked`,
      });
    }
    // A revoked score acceptance no longer holds the baseline down: the
    // page is measured against the 100 target again.
    if (row.kind === "score" && row.category) {
      await tx.execute(sql`
        UPDATE quality_baselines SET baseline = ${INITIAL_BASELINE}, below_streak = 0, updated_at = now()
        WHERE page_id = ${row.page_id}::uuid AND category = ${row.category}
      `);
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "quality_acceptances.revoke",
      input,
      succeeded: true,
      entityId: input.acceptanceId,
      resultSummary: `revoked ${row.kind} ${row.audit_id ?? row.category ?? ""}${input.reason ? `: ${input.reason}` : ""}`,
    });
    return ok({ revoked: true });
  },
});
