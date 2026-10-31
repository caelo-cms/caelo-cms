// SPDX-License-Identifier: MPL-2.0

import {
  type AnyPgColumn,
  bigint,
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { templates } from "./templates.js";

/**
 * A composed page. Pages reference modules through `page_modules` only — the
 * page itself never stores raw HTML, enforcing the Page Layer invariant
 * (CMS_REQUIREMENTS §3.1, CLAUDE.md §2).
 *
 * Identity is the page `id`. `slug` is one URL segment — unique only
 * where two pages would otherwise share a path (0264, epic #690): the
 * composed `current_path` is what is unique per branch. SEO fields live
 * in the separate `page_seo` table.
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
    // 0263 — nested page URLs: the parent page whose path this page's
    // path extends ("/<parent chain>/<slug>"). NULL = top level. Cycle /
    // depth / homepage rules are op-level (pages.create, pages.move_many).
    parentPageId: uuid("parent_page_id").references((): AnyPgColumn => pages.id),
    title: text("title").notNull(),
    // #1142 (0358) — the breadcrumb / navigation label, translated with
    // the page; replaced the internal `name` (0020).
    shortTitle: text("short_title").notNull(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => templates.id),
    /**
     * Epic #1107 (0351) — what the page IS. `page_types` has no drizzle
     * mirror; the FK lives in SQL.
     */
    pageTypeId: uuid("page_type_id").notNull(),
    /**
     * #1276 (0443) — whether someone chose `pageTypeId` for this page. False
     * only for pages that sat on the old stored default type. The ops
     * always state it; the default answers an INSERT that omits it (the
     * previous image during a roll) with "not chosen".
     */
    pageTypeConfirmed: boolean("page_type_confirmed").notNull().default(false),
    /** Property values, validated against the page type by the ops. */
    properties: jsonb("properties").notNull().default({}),
    /** Set by the first Publish live, never by the AI. */
    firstPublishedAt: timestamp("first_published_at", { withTimezone: true }),
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
  // Path uniqueness lives in SQL as the partial, branch-aware
  // pages_current_path_branch_uidx (0211) — not expressible as a drizzle
  // `unique()`, so the table callback is empty.
  (_t) => [],
);
