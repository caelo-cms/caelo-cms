// SPDX-License-Identifier: MPL-2.0

import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { pageModuleContent } from "./page_module_content.js";
import { siteSnapshots } from "./site_snapshots.js";

/**
 * v0.4.0 — Snapshot of one page_module_content row at the moment of a write.
 *
 * `state` JSONB carries { contentValues, version }. Reverting copies state
 * back into the live row and emits a fresh snapshot — history is append-only,
 * same shape as module_snapshots.
 *
 * site_snapshots already carries `chat_branch_id` + `chat_id`, so the
 * preview-time branch overlay + publish-time merge re-use existing
 * infrastructure; no new join keys needed.
 */
export const pageModuleContentSnapshots = pgTable("page_module_content_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteSnapshotId: uuid("site_snapshot_id")
    .notNull()
    .references(() => siteSnapshots.id, { onDelete: "cascade" }),
  pageModuleContentId: uuid("page_module_content_id")
    .notNull()
    .references(() => pageModuleContent.id, { onDelete: "cascade" }),
  pageId: uuid("page_id").notNull(),
  blockName: text("block_name").notNull(),
  position: integer("position").notNull(),
  state: jsonb("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
