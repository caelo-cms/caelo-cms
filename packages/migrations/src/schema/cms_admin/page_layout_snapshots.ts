// SPDX-License-Identifier: MPL-2.0

import { jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { pages } from "./pages.js";
import { siteSnapshots } from "./site_snapshots.js";

/**
 * Snapshot of one page's module layout only:
 *   { schemaVersion, blocks: [{ blockName, moduleIds: [uuid, …] }, …] }
 * Lives in its own table so a layout-only change (drag a module from one
 * slot to another) does not have to copy the page metadata too.
 */
export const pageLayoutSnapshots = pgTable("page_layout_snapshots", {
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
