// SPDX-License-Identifier: MPL-2.0

import { bigint, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { actors } from "./actors.js";
import { modules } from "./modules.js";

/**
 * v0.12.0 — Content as a first-class primitive.
 *
 * A `content_instances` row carries the values that fill a module's
 * `{{fieldName}}` placeholders. Identity is row-level, not placement-
 * level — two placements (or N) of the same module can reference the
 * same `content_instances` row via `page_modules.content_instance_id`
 * and `sync_mode='synced'`. Editing the row propagates everywhere it
 * is bound.
 *
 * For an unsynced placement (the default), the placement holds its
 * own private row.
 *
 * `chat_branch_id` mirrors the v0.9.0 branched-create pattern on
 * `modules` / `templates` / `pages` so chats can author brand-new
 * instances invisible to other chats until `chat.merge_to_main`.
 */
export const contentInstances = pgTable("content_instances", {
  id: uuid("id").primaryKey().defaultRandom(),
  moduleId: uuid("module_id")
    .notNull()
    .references(() => modules.id),
  /** Optional human-readable label ("primary-cta", "homepage-hero"). */
  slug: text("slug"),
  /** Shown in the content library list view. */
  displayName: text("display_name"),
  /**
   * Object mapping module field name → value. For fields of kind
   * `module` / `module-list`, the value is `{ moduleId, contentInstanceId }`
   * or an array thereof (the nested-module reference shape).
   */
  values: jsonb("values").notNull().default({}),
  version: bigint("version", { mode: "number" }).notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => actors.id),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  chatBranchId: uuid("chat_branch_id"),
});
