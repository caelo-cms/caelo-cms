// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — operations on the change journal itself
 * (docs/dev/state-and-changes.md, migration 0430).
 *
 * Garbage collection runs by a horizon rule: rows older than the
 * retention window go, but never past the cursor of a live persisted
 * consumer, so an idle one reads on where it stopped. A stalled consumer
 * (nothing delivered for a week) or a deactivated plugin's holds nothing
 * back; a cursor below the recorded horizon runs its rebuild-from-source
 * instead of reading.
 */

import {
  collectJournalGarbage,
  defineOperation,
  JOURNAL_RETENTION_MS,
  JOURNAL_STALLED_CONSUMER_MS,
  type TransactionRunner,
} from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

/**
 * Rows one call deletes at most. Each call is its own short transaction:
 * a pass of one long transaction would hold every reader's re-scan window
 * open (its xmin) for as long as it ran.
 */
const JOURNAL_GC_BATCH = 10_000;

export const collectJournalGarbageOp = defineOperation({
  name: "change_journal.collect_garbage",
  // Why human-only: no human or AI ever needs to trim the journal; the
  // maintenance worker does it on its interval.
  actorScope: ["system"],
  // Why site-wide: GC walks the journal's tail by age, whatever was written.
  readScope: "site",
  database: "cms_admin",
  input: z
    .object({
      /** Overrides the retention window (tests). */
      retentionMs: z.number().int().min(0).max(JOURNAL_RETENTION_MS).optional(),
      /** Overrides when a consumer counts as stalled (tests). */
      stalledConsumerMs: z.number().int().min(0).max(JOURNAL_STALLED_CONSUMER_MS).optional(),
    })
    .strict(),
  output: z.object({
    deleted: z.number().int().nonnegative(),
    /** A full batch went: more rows are due, call again. */
    more: z.boolean(),
  }),
  handler: async (_ctx, input, tx) => {
    const deleted = await collectJournalGarbage(tx, {
      ...(input.retentionMs !== undefined ? { retentionMs: input.retentionMs } : {}),
      ...(input.stalledConsumerMs !== undefined
        ? { stalledConsumerMs: input.stalledConsumerMs }
        : {}),
      batch: JOURNAL_GC_BATCH,
    });
    const legacy = await collectRetiredFontUsageLog(tx, JOURNAL_GC_BATCH);
    return ok({
      deleted,
      more: deleted >= JOURNAL_GC_BATCH || legacy >= JOURNAL_GC_BATCH,
    });
  },
});

/**
 * Trim `font_usage_changes`, whose writer triggers stay for one release so
 * the previous image's font cache stays correct during the roll and after a
 * rollback (0430). Its own trimming lived in the reader this release
 * removed, so the journal's GC does it, with the same rule: rows of ended
 * transactions go, and a horizon row makes every older cached snapshot of
 * the previous image stale. Removed with the table (0442).
 *
 * @returns how many change rows were deleted
 */
async function collectRetiredFontUsageLog(tx: TransactionRunner, batch: number): Promise<number> {
  const rows = (await tx.execute(sql`
    WITH h AS (SELECT pg_snapshot_xmin(pg_current_snapshot()) AS xmin),
    victims AS (
      SELECT f.kind, f.xid FROM font_usage_changes f, h
       WHERE f.kind = 'change' AND f.xid < h.xmin
       ORDER BY f.xid
       LIMIT ${batch}
       FOR UPDATE OF f SKIP LOCKED
    ),
    removed AS (
      DELETE FROM font_usage_changes f USING victims v
       WHERE f.kind = v.kind AND f.xid = v.xid
       RETURNING 1
    ),
    horizon AS (
      INSERT INTO font_usage_changes (kind, xid, horizon)
        SELECT 'horizon', pg_current_xact_id(), h.xmin FROM h WHERE EXISTS (SELECT 1 FROM removed)
        ON CONFLICT (kind, xid) DO UPDATE
          SET horizon = GREATEST(font_usage_changes.horizon, EXCLUDED.horizon)
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM removed)::int AS deleted, (SELECT count(*) FROM horizon)::int AS recorded
  `)) as unknown as { deleted: number }[];
  // Older horizon rows decide nothing once a newer one exists.
  await tx.execute(sql`
    DELETE FROM font_usage_changes
     WHERE kind = 'horizon'
       AND horizon < (SELECT h.horizon FROM font_usage_changes h
                       WHERE h.kind = 'horizon' ORDER BY h.horizon DESC LIMIT 1)
  `);
  return rows[0]?.deleted ?? 0;
}
