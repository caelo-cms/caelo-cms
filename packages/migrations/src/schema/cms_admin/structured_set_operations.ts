// SPDX-License-Identifier: MPL-2.0

import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { siteSnapshots } from "./site_snapshots.js";

/**
 * v0.5.0 — Per-operation snapshots for ordered-list structured_sets
 * (nav-menu, taxonomy, link-list).
 *
 * Whole-blob structured_sets.set diffs the incoming items array
 * against the current state and emits one row here per discrete edit
 * (add / rename / move / delete / update). The stage picker can
 * include / exclude individual operations rather than the whole list,
 * so two chats can each add a different nav item without conflict.
 *
 * Theme structured_sets stay whole-blob — no per-item meaning.
 */
export const structuredSetOperations = pgTable("structured_set_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteSnapshotId: uuid("site_snapshot_id")
    .notNull()
    .references(() => siteSnapshots.id, { onDelete: "cascade" }),
  structuredSetId: uuid("structured_set_id").notNull(),
  opKind: text("op_kind").notNull(),
  itemId: text("item_id").notNull(),
  opPayload: jsonb("op_payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
