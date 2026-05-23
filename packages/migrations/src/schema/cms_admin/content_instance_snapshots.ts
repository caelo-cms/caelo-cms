// SPDX-License-Identifier: MPL-2.0

import { jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { contentInstances } from "./content_instances.js";
import { siteSnapshots } from "./site_snapshots.js";

/**
 * v0.12.0 — Snapshot of one `content_instances` row at the moment of
 * a write.
 *
 * `state` JSONB carries the full `ContentInstanceState` (see
 * `packages/admin-core/src/snapshots/state.ts`). Reverting copies
 * state back into the live row and emits a fresh snapshot — same
 * append-only history shape as `module_snapshots`.
 *
 * `site_snapshots.chat_branch_id` carries the branch tag, so chat-
 * branch isolation + publish-merge reuse the existing infrastructure;
 * no new join keys needed.
 */
export const contentInstanceSnapshots = pgTable("content_instance_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteSnapshotId: uuid("site_snapshot_id")
    .notNull()
    .references(() => siteSnapshots.id, { onDelete: "cascade" }),
  contentInstanceId: uuid("content_instance_id")
    .notNull()
    .references(() => contentInstances.id, { onDelete: "cascade" }),
  state: jsonb("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
