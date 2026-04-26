// SPDX-License-Identifier: MPL-2.0

import { jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { siteSnapshots } from "./site_snapshots.js";
import { templates } from "./templates.js";

/**
 * Snapshot of one template + its slot inventory at the moment of a write.
 * `state` JSONB carries
 *   { schemaVersion, slug, displayName, html, css, deletedAt,
 *     blocks: [{ name, displayName, position }, …] }
 * so reverting also restores the template_blocks rows.
 */
export const templateSnapshots = pgTable("template_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteSnapshotId: uuid("site_snapshot_id")
    .notNull()
    .references(() => siteSnapshots.id, { onDelete: "cascade" }),
  templateId: uuid("template_id")
    .notNull()
    .references(() => templates.id),
  state: jsonb("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
