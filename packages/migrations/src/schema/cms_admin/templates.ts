// SPDX-License-Identifier: MPL-2.0

import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * A site template — the layout shell pages compose into. Holds the document
 * skeleton (head + body chrome) with `<caelo-slot name="…">` markers where
 * page modules render. Slots are inventoried in `template_blocks` so the
 * Validator can verify that a page's block references exist.
 */
export const templates = pgTable("templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  displayName: text("display_name").notNull(),
  /** Full document HTML, including `<caelo-slot name="…">` markers. */
  html: text("html").notNull(),
  css: text("css").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
