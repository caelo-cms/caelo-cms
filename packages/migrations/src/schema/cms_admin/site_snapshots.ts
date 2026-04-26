// SPDX-License-Identifier: MPL-2.0

import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { actors } from "./actors.js";

/**
 * One row per atomic write group. Entity-level snapshot rows
 * (module_snapshots, template_snapshots, page_snapshots,
 * page_layout_snapshots) reference this. P5 will populate chat_task_id
 * (consecutive snapshots from the same chat task collapse into one
 * timeline entry) and chat_branch_id (ephemeral chat preview branches);
 * P4 leaves both NULL. revert_of points at the snapshot a revert restored
 * — the revert itself is appended as a new snapshot, never destructive.
 */
export const siteSnapshots = pgTable("site_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id")
    .notNull()
    .references(() => actors.id),
  /** Structured operation kind — matches the Query API op name. */
  opKind: text("op_kind").notNull(),
  /** Human-readable label for the timeline (e.g. "modules.update slug=hero"). */
  description: text("description").notNull(),
  chatTaskId: uuid("chat_task_id"),
  chatBranchId: uuid("chat_branch_id"),
  // Self-FK is added in SQL but omitted from drizzle to dodge a circular
  // import; the runtime guarantees the FK is enforced.
  revertOf: uuid("revert_of"),
  /** P4 archival hook. snapshots.archive_older_than sets it; snapshots.list
   * defaults to filtering archived_at IS NULL. P12A wires the cron. */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
