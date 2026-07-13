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
  // issue #29 — provenance for role='user' rows the operator did not type.
  // Auto-injected status lines (crawl-completion nudge, post-approval
  // continuations) still reach the model as user turns but carry
  // origin='system' so the UI renders them as muted status notes, not
  // "You:". NULL / 'operator' = a message the operator actually typed.
  origin: text("origin"),
  toolCalls: jsonb("tool_calls"),
  toolCallId: text("tool_call_id"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  cachedTokens: integer("cached_tokens"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
