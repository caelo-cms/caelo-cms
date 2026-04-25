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
  /** Subject of the operation when it has one — the user/role/etc the op acted on.
   * Lets `who did what to whom` queries work without parsing input_hash. */
  entityId: uuid("entity_id"),
  /** Short, redaction-aware result fingerprint — e.g. last 8 chars of a session token,
   * permission count after an update, attempted-email on a failed login. Distinguishes
   * two events with identical input but different outcomes. */
  resultSummary: text("result_summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
