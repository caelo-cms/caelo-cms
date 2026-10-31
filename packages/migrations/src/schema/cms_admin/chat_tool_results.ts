// SPDX-License-Identifier: MPL-2.0

import { boolean, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { actors } from "./actors.js";
import { chatSessions } from "./chat_sessions.js";

/**
 * One row per dispatched tool call of a chat, keyed by
 * (chat_session_id, tool_call_id): the dedup cache the chat-runner and the
 * Power-MCP consult before running a call (P5.2), and — #1275 — the place a
 * failed write call is kept for `retry_tool_call`.
 */
export const chatToolResults = pgTable(
  "chat_tool_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatSessionId: uuid("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    toolCallId: text("tool_call_id").notNull(),
    toolName: text("tool_name").notNull(),
    resultOk: boolean("result_ok").notNull(),
    resultContent: text("result_content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** #1275 — the normalized arguments of a kept failure; NULL otherwise. */
    args: jsonb("args"),
    /** #1275 — the operator a kept call ran for; only they read it back (RLS). */
    argsActorId: uuid("args_actor_id").references(() => actors.id, { onDelete: "cascade" }),
    /** #1275 — set while a retry of the kept call runs (atomic claim). */
    retryClaimedAt: timestamp("retry_claimed_at", { withTimezone: true }),
  },
  (t) => [unique().on(t.chatSessionId, t.toolCallId)],
);
