// SPDX-License-Identifier: MPL-2.0

import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { actors } from "./actors.js";

/**
 * Owner-curated context that prepends every AI system prompt. One row per
 * `slot` (brand-voice / tone / banned-phrases / instructions / glossary).
 * Updates replace; AI may *propose* additions via `site_memory_proposals`
 * but only Owners can accept them into this table.
 */
export const siteAiMemory = pgTable("site_ai_memory", {
  id: uuid("id").primaryKey().defaultRandom(),
  slot: text("slot", {
    enum: ["brand-voice", "tone", "banned-phrases", "instructions", "glossary"],
  })
    .notNull()
    .unique(),
  body: text("body").notNull(),
  updatedBy: uuid("updated_by")
    .notNull()
    .references(() => actors.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
