// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — operations on the change journal itself
 * (docs/dev/state-and-changes.md, migration 0430).
 *
 * Garbage collection runs by a horizon rule, not "after every consumer":
 * rows older than the retention window go, and a consumer whose cursor is
 * below the recorded horizon runs its rebuild-from-source instead of
 * reading. So a dead or deactivated consumer never holds the journal back.
 */

import { collectJournalGarbage, defineOperation, JOURNAL_RETENTION_MS } from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
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
      batch: JOURNAL_GC_BATCH,
    });
    return ok({ deleted, more: deleted >= JOURNAL_GC_BATCH });
  },
});
