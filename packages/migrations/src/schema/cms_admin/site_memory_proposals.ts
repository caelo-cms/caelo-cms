// SPDX-License-Identifier: MPL-2.0

import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { actors } from "./actors.js";
import { chatSessions } from "./chat_sessions.js";

/**
 * AI-proposed memory additions land here in `pending` state. Owner-only
 * review (accept moves the body into `site_ai_memory`; reject just sets
 * status). The AI never writes to `site_ai_memory` directly — proposal
 * gating is the §17 "all skills/memory require Owner confirmation" rule
 * applied to memory growth.
 */
export const siteMemoryProposals = pgTable("site_memory_proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  proposedBy: uuid("proposed_by")
    .notNull()
    .references(() => actors.id),
  chatSessionId: uuid("chat_session_id").references(() => chatSessions.id, {
    onDelete: "set null",
  }),
  slot: text("slot", {
    enum: ["brand-voice", "tone", "banned-phrases", "instructions", "glossary"],
  }).notNull(),
  body: text("body").notNull(),
  rationale: text("rationale").notNull(),
  status: text("status", { enum: ["pending", "accepted", "rejected"] })
    .notNull()
    .default("pending"),
  reviewedBy: uuid("reviewed_by").references(() => actors.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
