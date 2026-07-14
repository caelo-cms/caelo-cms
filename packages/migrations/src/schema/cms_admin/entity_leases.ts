// SPDX-License-Identifier: MPL-2.0

import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * issue #264 — per-entity sub-leases within a shared chat branch.
 *
 * chat_entity_locks keys on the branch SESSION, so parallel sibling
 * subagents (which all share the parent's branch) resolve to the same
 * session and the branch lock lets them all write the same entity — a
 * silent last-writer-wins lost update. This table adds a short-TTL lease
 * keyed on (entity, branch) whose `holderKey` is the acquiring writer's
 * OWN session (`ctx.chatTaskId`), so a sibling with a different holder is
 * refused cleanly. Same-holder re-acquire is a no-op refresh; expired
 * leases are taken over so a died subagent never wedges an entity.
 *
 * See migration 0142_p_issue_264_entity_leases.sql for the rationale.
 */
export const entityLeases = pgTable(
  "entity_leases",
  {
    entityKind: text("entity_kind").notNull(),
    entityId: uuid("entity_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    holderKey: text("holder_key").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.entityKind, t.entityId, t.branchId] }),
    holderIdx: index("entity_leases_holder_idx").on(t.holderKey),
    branchIdx: index("entity_leases_branch_idx").on(t.branchId),
  }),
);
