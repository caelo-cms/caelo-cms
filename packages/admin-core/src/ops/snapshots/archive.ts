// SPDX-License-Identifier: MPL-2.0

/**
 * Sets `archived_at = now()` on snapshots created before a cutoff. P12A
 * wires the cron caller; P4 ships the op so the schema + behaviour are
 * already exercised by tests when the cron lands.
 *
 * actorScope is `["system"]` only — archival is a maintenance task, never
 * a user-driven action. The hot list (`snapshots.list`) filters
 * archived_at IS NULL by default; setting `includeArchived: true` reads
 * the cold set when needed (audit / compliance flows in P14+).
 */

import { defineOperation } from "@caelo-cms/query-api";
import { archiveOlderThanInput, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";

export const archiveOlderThanOp = defineOperation({
  name: "snapshots.archive_older_than",
  actorScope: ["system"],
  database: "cms_admin",
  input: archiveOlderThanInput,
  output: z.object({ archivedCount: z.number().int().nonnegative() }),
  handler: async (ctx, input, tx) => {
    // Two-step so we can both bound the work (LIMIT) and report the count
    // back. Postgres doesn't support LIMIT on UPDATE directly; the IN-list
    // gives us the same effect on the hot path.
    const target = (await tx.execute(sql`
      SELECT id FROM site_snapshots
      WHERE archived_at IS NULL AND created_at < ${input.before}
      ORDER BY created_at ASC
      LIMIT ${input.limit}
    `)) as unknown as { id: string }[];

    if (target.length === 0) {
      return ok({ archivedCount: 0 });
    }

    await tx.execute(sql`
      UPDATE site_snapshots
      SET archived_at = now()
      WHERE id IN (${sql.join(
        target.map((t) => sql`${t.id}`),
        sql`, `,
      )})
    `);

    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "snapshots.archive_older_than",
      input,
      succeeded: true,
      resultSummary: `archived=${target.length}`,
    });

    return ok({ archivedCount: target.length });
  },
});
