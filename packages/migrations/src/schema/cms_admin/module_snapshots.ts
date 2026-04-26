// SPDX-License-Identifier: MPL-2.0

import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { modules } from "./modules.js";
import { siteSnapshots } from "./site_snapshots.js";

/**
 * Snapshot of one module at the moment of a write. `state` JSONB carries
 * { schemaVersion, slug, displayName, html, css, js, deletedAt }. Reverting
 * a module copies state back into the live `modules` row and emits a fresh
 * snapshot — history is append-only.
 *
 * experiment_id + variant_label are P12A A/B hooks. P4 leaves them NULL.
 */
export const moduleSnapshots = pgTable("module_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteSnapshotId: uuid("site_snapshot_id")
    .notNull()
    .references(() => siteSnapshots.id, { onDelete: "cascade" }),
  moduleId: uuid("module_id")
    .notNull()
    .references(() => modules.id),
  state: jsonb("state").notNull(),
  experimentId: uuid("experiment_id"),
  variantLabel: text("variant_label"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
