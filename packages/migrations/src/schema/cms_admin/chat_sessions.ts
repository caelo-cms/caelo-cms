// SPDX-License-Identifier: MPL-2.0

import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { actors } from "./actors.js";

/**
 * One chat session per editor conversation. `chat_branch_id` is the
 * ephemeral preview branch — every snapshot the AI emits inside this
 * chat carries it (P4 reserved the column on site_snapshots). Publish
 * merges the branch into main and stamps `published_at`.
 *
 * `engaged_skills` is filled by P10A; P5 leaves it empty.
 */
export const chatSessions = pgTable("chat_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => actors.id),
  chatBranchId: uuid("chat_branch_id").notNull().unique(),
  engagedSkills: jsonb("engaged_skills").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});
