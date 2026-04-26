// SPDX-License-Identifier: MPL-2.0

import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { chatSessions } from "./chat_sessions.js";

/**
 * One row per message in a chat — user prompts, assistant text + tool
 * calls, tool results. Assistant rows carry the per-call token counts
 * the provider returned (also aggregated into `ai_calls`).
 */
export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  chatSessionId: uuid("chat_session_id")
    .notNull()
    .references(() => chatSessions.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant", "tool"] }).notNull(),
  content: text("content").notNull(),
  toolCalls: jsonb("tool_calls"),
  toolCallId: text("tool_call_id"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  cachedTokens: integer("cached_tokens"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
