// SPDX-License-Identifier: MPL-2.0

import { integer, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { modules } from "./modules.js";
import { pages } from "./pages.js";

/**
 * Ordered modules per (page, block). `block_name` references a
 * `template_blocks.name` slot on the page's template. Pages compose by
 * appending rows here — the modules table is never inlined into pages.
 *
 * Cascading delete from `pages` keeps the table consistent when a page is
 * hard-deleted (P3 only soft-deletes pages, but the FK is correct for any
 * future hard-delete path).
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
  },
  (t) => [primaryKey({ columns: [t.pageId, t.blockName, t.position] })],
);
