// SPDX-License-Identifier: MPL-2.0

import { bigint, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * #392 (epic #380) — transactional domain-event outbox. Append-only;
 * written in the SAME transaction as the triggering core write (the op
 * handlers call `emitDomainEvent`), polled by release-signed plugin
 * workers via ctx.events (capability `domain_events`). Rows are
 * ephemeral signals pruned by the retention GC — snapshots remain the
 * durable history.
 *
 * `id` is a bigint identity in SQL (monotonic cursor); the kind CHECK,
 * RLS policy, and indexes live in 0210_plugin_v2_domain_events.sql.
 * `plugin_event_cursors` (same migration) persists each plugin's read
 * position and is not modelled here.
 */
export const domainEvents = pgTable("domain_events", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  kind: text("kind", {
    enum: ["page.created", "page.updated", "page.deleted", "page.published", "module.updated"],
  }).notNull(),
  entityId: uuid("entity_id").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
