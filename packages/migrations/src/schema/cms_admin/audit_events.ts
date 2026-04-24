// SPDX-License-Identifier: MPL-2.0

import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { actors } from "./actors.js";

/**
 * One row per Query API operation execution. RLS-scoped per actor (owner-only read)
 * with a `system` bypass so the auditor can run site-wide queries. Used by the P5
 * cost dashboard and the P16 audit log export.
 */
export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  // NOT NULL — an RLS policy that allowed NULL = NULL would leak rows to anonymous callers.
  actorId: uuid("actor_id")
    .notNull()
    .references(() => actors.id),
  operation: text("operation").notNull(),
  inputHash: text("input_hash").notNull(),
  succeeded: boolean("succeeded").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
