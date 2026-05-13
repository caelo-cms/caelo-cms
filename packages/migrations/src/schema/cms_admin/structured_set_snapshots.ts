// SPDX-License-Identifier: MPL-2.0

import { jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { siteSnapshots } from "./site_snapshots.js";

/**
 * Whole-blob branched snapshot of a structured_set (theme tokens, nav menu,
 * taxonomy, link list). v0.5.3 — companion to the per-op rows in
 * structured_set_operations: this table is the BRANCHED READ representation
 * (preview overlay reads from here); the operations table is the picker's
 * stage-granularity layer.
 */
export const structuredSetSnapshots = pgTable("structured_set_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteSnapshotId: uuid("site_snapshot_id")
    .notNull()
    .references(() => siteSnapshots.id, { onDelete: "cascade" }),
  structuredSetId: uuid("structured_set_id").notNull(),
  state: jsonb("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
