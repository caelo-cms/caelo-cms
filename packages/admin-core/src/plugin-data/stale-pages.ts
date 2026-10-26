// SPDX-License-Identifier: MPL-2.0

/**
 * #1155 — keeping `plugin_data_stale_pages` honest when production changes
 * under it.
 *
 * A mark is pending while `last_marked_at > baked_through`. A plugin-data
 * build sets `baked_through` to the instant it read the plugin's data. But
 * a Publish live replaces the live files with a Stage that baked its data
 * when IT was built, and a rollback puts an older build back — both can
 * take an item a plugin-data build already baked out of the HTML again.
 * The item stays visible (its `data-baked-at` is older, so the delta feed
 * serves it), but its bake must be redone: these helpers make those marks
 * pending again, so the next tick re-bakes them on top of the new live
 * build.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

/**
 * Publish live of `sourceRunId`'s build: its bakes carry the data of that
 * run's start, so every bake recorded as newer is pending again.
 */
export async function rewindBakesToRun(tx: TransactionRunner, sourceRunId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE plugin_data_stale_pages s
       SET baked_through = r.started_at
      FROM deploy_runs r
     WHERE r.id = ${sourceRunId}::uuid
       AND s.baked_through > r.started_at
  `);
}

/**
 * A rollback: the build put back may predate any bake, and which data it
 * carries is not recorded per page, so every recorded bake is pending
 * again. Re-baking a page whose data did not change publishes nothing.
 */
export async function forgetAllBakes(tx: TransactionRunner): Promise<void> {
  await tx.execute(sql`
    UPDATE plugin_data_stale_pages SET baked_through = NULL WHERE baked_through IS NOT NULL
  `);
}
