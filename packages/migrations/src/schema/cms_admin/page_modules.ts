// SPDX-License-Identifier: MPL-2.0

import { integer, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { contentInstances } from "./content_instances.js";
import { modules } from "./modules.js";
import { pages } from "./pages.js";

/**
 * Ordered modules per (page, block). `block_name` references a
 * `template_blocks.name` slot on the page's template. Pages compose by
 * appending rows here — the modules table is never inlined into pages.
 *
 * v0.12.0 — every placement carries a `content_instance_id` (the
 * content row that fills the module's `{{fieldName}}` placeholders)
 * and a `sync_mode` flag:
 *   - 'synced'   → editing the bound content_instance propagates to
 *                  every other placement that binds to the same row.
 *   - 'unsynced' → the placement holds a private content_instance
 *                  forked on demand from a shared one or minted fresh
 *                  on placement create. Default for new placements.
 *
 * Cascading delete from `pages` keeps the table consistent when a
 * page is hard-deleted. The FK to `content_instances` is
 * `ON DELETE RESTRICT` — soft-deleting a content_instance that has
 * placements is blocked at the op layer (see CLAUDE.md §11.A — the
 * propose/execute gate lands in v0.12.0.1).
 */
export const pageModules = pgTable(
  "page_modules",
  {
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    blockName: text("block_name").notNull(),
    position: integer("position").notNull(),
    moduleId: uuid("module_id")
      .notNull()
      .references(() => modules.id),
    contentInstanceId: uuid("content_instance_id")
      .notNull()
      .references(() => contentInstances.id, { onDelete: "restrict" }),
    syncMode: text("sync_mode").notNull().default("unsynced"),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.blockName, t.position] })],
);
