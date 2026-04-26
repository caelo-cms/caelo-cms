// SPDX-License-Identifier: MPL-2.0

import { bigint, boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { actors } from "./actors.js";
import { chatSessions } from "./chat_sessions.js";

/**
 * Per-call accounting. `cost_estimate_microcents` stored as bigint to
 * dodge float drift — the dashboard divides by 1e8 to render USD.
 */
export const aiCalls = pgTable("ai_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  chatSessionId: uuid("chat_session_id").references(() => chatSessions.id, {
    onDelete: "set null",
  }),
  actorId: uuid("actor_id")
    .notNull()
    .references(() => actors.id),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  cachedTokens: integer("cached_tokens").notNull().default(0),
  costEstimateMicrocents: bigint("cost_estimate_microcents", { mode: "bigint" })
    .notNull()
    .default(0n),
  durationMs: integer("duration_ms").notNull().default(0),
  succeeded: boolean("succeeded").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
