// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1268 — the draft head's rebuild (rule 3 of
 * docs/dev/state-and-changes.md: every derived structure ships a rebuild
 * from source).
 *
 *   chat.rebuild_draft_head   recompute `draft_pending_entities` from the
 *                             snapshot history and report how far the
 *                             maintained head had drifted.
 *
 * The head is maintained by triggers in every writing transaction
 * (migration 0433), so a rebuild finds no drift unless a maintainer has a
 * bug; the consistency check after every integration test file
 * (scripts/test-preload.ts) is what catches such a bug. The rebuild exists
 * to repair an install a buggy release left inconsistent, and it reports
 * the drift so that case is visible instead of silently fixed.
 */

import { defineOperation } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";

export const rebuildDraftHeadOp = defineOperation({
  name: "chat.rebuild_draft_head",
  // Why site-wide: a rebuild recomputes the head of every branch from the whole pending history.
  readScope: "site",
  // Why system-only: repair plumbing run by an operator script or a migration; nothing a person
  // or the AI decides — the head is derived state and a rebuild never changes what is pending.
  actorScope: ["system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    /** Head rows after the rebuild. */
    rows: z.number().int().nonnegative(),
    /** Rows the maintained head had that the source does not (0 = no drift). */
    stale: z.number().int().nonnegative(),
    /** Rows the source has that the maintained head lacked (0 = no drift). */
    missing: z.number().int().nonnegative(),
  }),
  handler: async (ctx, input, tx) => {
    const drift = (await tx.execute(sql`
      WITH computed AS (SELECT * FROM caelo_draft_head_computed())
      SELECT
        (SELECT count(*)::int FROM (SELECT * FROM draft_pending_entities EXCEPT SELECT * FROM computed) s) AS stale,
        (SELECT count(*)::int FROM (SELECT * FROM computed EXCEPT SELECT * FROM draft_pending_entities) m) AS missing
    `)) as unknown as { stale: number; missing: number }[];
    const rebuilt = (await tx.execute(sql`
      SELECT caelo_draft_head_rebuild() AS rows
    `)) as unknown as { rows: number }[];
    const result = {
      rows: rebuilt[0]?.rows ?? 0,
      stale: drift[0]?.stale ?? 0,
      missing: drift[0]?.missing ?? 0,
    };
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "chat.rebuild_draft_head",
      input,
      succeeded: true,
      resultSummary: `rows=${result.rows} stale=${result.stale} missing=${result.missing}`,
    });
    return ok(result);
  },
});
