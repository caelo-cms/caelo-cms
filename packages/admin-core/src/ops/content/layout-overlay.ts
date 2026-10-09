// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #620 — layout chrome placements as draft state.
 *
 * `layout_modules.set` inside a chat no longer writes the live
 * `layout_modules` table: it records the block's new module list as a
 * pending `layout_module_snapshots` row on the chat's branch. Like every
 * other draft change it shows in that branch's views, a Stage replays it
 * into the live table (chat/publish.ts), and an undo just stops it being
 * pending — nothing reaches main (or an automatic production build)
 * before a Stage.
 *
 * {@link effectiveLayoutModulesSql} is the one read every branch-aware
 * caller uses: live rows, with each block a pending branch state exists
 * for replaced by that state's list.
 */

import { type SQL, sql } from "drizzle-orm";
import { pendingSnapshotSql } from "../../draft.js";

/**
 * A row source `(layout_id, block_name, position, module_id)` of the
 * layout placements as `branchId` sees them (live when null). Use as
 * `FROM (${effectiveLayoutModulesSql(b)}) lm`.
 */
export function effectiveLayoutModulesSql(branchId: string | null | undefined): SQL {
  if (!branchId) {
    return sql`SELECT layout_id, block_name, position, module_id FROM layout_modules`;
  }
  return sql`
    WITH overlay AS (
      SELECT DISTINCT ON (lms.layout_id, lms.block_name) lms.layout_id, lms.block_name, lms.state
      FROM layout_module_snapshots lms
      JOIN site_snapshots ss ON ss.id = lms.site_snapshot_id
      WHERE ss.chat_branch_id = ${branchId}::uuid AND ${pendingSnapshotSql()}
      ORDER BY lms.layout_id, lms.block_name, ss.created_at DESC, lms.created_at DESC
    )
    SELECT live.layout_id, live.block_name, live.position, live.module_id
    FROM layout_modules live
    WHERE NOT EXISTS (
      SELECT 1 FROM overlay o WHERE o.layout_id = live.layout_id AND o.block_name = live.block_name
    )
    UNION ALL
    SELECT o.layout_id, o.block_name, (e.ord - 1)::int AS position, e.mid::uuid AS module_id
    FROM overlay o
    CROSS JOIN LATERAL jsonb_array_elements_text(o.state->'moduleIds') WITH ORDINALITY AS e(mid, ord)
  `;
}
