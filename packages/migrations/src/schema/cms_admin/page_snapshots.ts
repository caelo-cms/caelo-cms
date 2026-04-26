// SPDX-License-Identifier: MPL-2.0

import { jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { pages } from "./pages.js";
import { siteSnapshots } from "./site_snapshots.js";

/**
 * Snapshot of page metadata only — slug, locale, title, templateId, status,
 * version, deletedAt. Page layout (the ordered module references) is in
 * page_layout_snapshots so reordering does not bloat this table.
 */
export const pageSnapshots = pgTable("page_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteSnapshotId: uuid("site_snapshot_id")
    .notNull()
    .references(() => siteSnapshots.id, { onDelete: "cascade" }),
  pageId: uuid("page_id")
    .notNull()
    .references(() => pages.id),
  state: jsonb("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
