// SPDX-License-Identifier: MPL-2.0

import {
  bigint,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { pages } from "./pages.js";

/**
 * v0.4.0 — Per-placement content store.
 *
 * Modules declare a `fields` schema (text/image/url/etc.) and a templated
 * HTML that references those fields as `{{name}}`. The actual values that
 * fill the template on a specific page placement live here.
 *
 * Keyed by (page_id, block_name, position) — same as `page_modules`. The
 * preview renderer joins page_modules → page_module_content, substitutes
 * field placeholders with content values, and composes the page HTML.
 *
 * Branch overlays for chats happen via `page_module_content_snapshots`
 * filtered on `chat_branch_id`. Module CODE is no longer branched.
 */
export const pageModuleContent = pgTable(
  "page_module_content",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    blockName: text("block_name").notNull(),
    position: integer("position").notNull(),
    /**
     * Object mapping field name → value. Missing fields fall back to the
     * module's `fields[i].default` at render time.
     */
    contentValues: jsonb("content_values").notNull().default({}),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pkPlacement: unique("page_module_content_placement_unq").on(t.pageId, t.blockName, t.position),
  }),
);
