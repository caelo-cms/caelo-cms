// SPDX-License-Identifier: MPL-2.0

import { bigint, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { templates } from "./templates.js";

/**
 * A composed page. Pages reference modules through `page_modules` only — the
 * page itself never stores raw HTML, enforcing the Page Layer invariant
 * (CMS_REQUIREMENTS §3.1, CLAUDE.md §2).
 *
 * `slug` is the globally unique public identity of a page (epic #380
 * #384 — locale left page identity; variant grouping is explicit
 * plugin data). SEO fields live in the separate `page_seo` table.
 */
export const pages = pgTable(
  "pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    // #390 — the COMPOSED public path, materialized by the write ops via
    // the URL composition point ("/" for the designated root; plugin
    // prefixes/slug formats included). Backfilled + trigger-defaulted in
    // 0211; unique per branch via pages_current_path_branch_uidx.
    currentPath: text("current_path").notNull(),
    title: text("title").notNull(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => templates.id),
    status: text("status", { enum: ["draft", "published"] })
      .notNull()
      .default("draft"),
    /**
     * Optimistic-concurrency token. Bumped on every successful write through
     * pages.update / pages.set_modules. Composer ships the version it loaded
     * back with every save; the op rejects with `HandlerError('Conflict')` if
     * it changed underneath. P4 snapshots key off this same column.
     */
    version: bigint("version", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  // Global slug uniqueness lives in SQL as the partial, branch-aware
  // pages_slug_branch_uidx (0201) — not expressible as a drizzle
  // `unique()`, so the table callback is empty.
  (_t) => [],
);
