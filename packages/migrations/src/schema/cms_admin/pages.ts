// SPDX-License-Identifier: MPL-2.0

import { bigint, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { templates } from "./templates.js";

/**
 * A composed page. Pages reference modules through `page_modules` only — the
 * page itself never stores raw HTML, enforcing the Page Layer invariant
 * (CMS_REQUIREMENTS §3.1, CLAUDE.md §2).
 *
 * `(slug, locale)` is the public identity of a page; locale defaults to `'en'`
 * here and full multi-locale config (URL strategy, hreflang, translation
 * status) lands in P9. SEO fields land in P8 in a separate `page_seo` table.
 */
export const pages = pgTable(
  "pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    locale: text("locale").notNull().default("en"),
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
  (t) => [unique("pages_slug_locale_unique").on(t.slug, t.locale)],
);
