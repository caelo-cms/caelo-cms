// SPDX-License-Identifier: MPL-2.0

import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * A reusable HTML/CSS/JS module. Pages reference modules by id; module updates
 * propagate to every page that references them on the next render. This is the
 * Module Layer (CMS_REQUIREMENTS §3.1) — the only place raw HTML lives.
 *
 * v0.4.0 split: modules carry STRUCTURE only. The HTML is a template that
 * references fields as `{{name}}` placeholders. The CONTENT (text, images,
 * link hrefs) that fills those placeholders lives at the page-placement level
 * in `page_module_content`. Module edits are global + immediate; content
 * edits are page-bound and branch-isolated per chat until publish.
 *
 * Soft-deleted via `deleted_at` so audit history and snapshot revert (P4) keep
 * working after a module is removed from the active catalog.
 */
export const modules = pgTable("modules", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  displayName: text("display_name").notNull(),
  html: text("html").notNull(),
  css: text("css").notNull().default(""),
  js: text("js").notNull().default(""),
  /**
   * v0.4.0 — field schema. Ordered array of:
   *   { name: "headline", kind: "text", label: "Headline", default: "" }
   * Kind enum validated at the Query API zod boundary.
   */
  fields: jsonb("fields").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
