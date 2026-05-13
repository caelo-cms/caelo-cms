// SPDX-License-Identifier: MPL-2.0

import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { chatSessions } from "./chat_sessions.js";

/**
 * v0.5.0 — Per-entity write locks for global entities.
 *
 * When a chat writes to a module / template / layout / structured_set
 * / redirect, the entity is locked to that chat's session until the
 * chat publishes or is discarded. Other chats get a structured
 * `kind: "Locked"` error at write time instead of silently
 * overwriting each other.
 *
 * Page-bound entities (pages, page_modules, page_module_content) are
 * covered by the per-page-chat gate (one chat per page); they don't
 * need entry-level locks here.
 */
export const chatEntityLocks = pgTable(
  "chat_entity_locks",
  {
    entityKind: text("entity_kind").notNull(),
    entityId: uuid("entity_id").notNull(),
    chatSessionId: uuid("chat_session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    chatBranchId: uuid("chat_branch_id").notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.entityKind, t.entityId] }),
  }),
);
