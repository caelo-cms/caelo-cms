// SPDX-License-Identifier: MPL-2.0

/**
 * #392 (epic #380) — transactional domain-event outbox emitter.
 *
 * One INSERT into `domain_events`, executed on the caller's OWN
 * transaction runner so the event commits and rolls back with the write
 * that caused it. This is the whole point of the outbox shape: a plugin
 * worker polling the table can never observe an event whose write was
 * rolled back, and an applied write can never lose its event.
 *
 * Emit sites live at the Query API boundary (the op handlers), NOT in
 * triggers — the op layer knows the semantic kind ("page.published" vs
 * "row updated") and already owns the tx.
 *
 * Consumers: plugin workers via `ctx.events.poll` (plugin-host,
 * capability `domain_events`, release-signed only). Events are
 * ephemeral signals — snapshots remain the durable history; the GC
 * worker prunes past the retention window.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

export type DomainEventKind =
  | "page.created"
  | "page.updated"
  | "page.deleted"
  | "page.published"
  | "module.updated";

export interface DomainEventInput {
  readonly kind: DomainEventKind;
  readonly entityId: string;
  /**
   * Consumer-facing context that saves a join: `slug` at event time,
   * `chatBranchId` when the write was branch-scoped (absent = live
   * write — most workers only care about those), plus kind-specific
   * fields. Keep it small; the event is a signal, not a snapshot.
   */
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** Insert one outbox row on the caller's tx. */
export async function emitDomainEvent(
  tx: TransactionRunner,
  input: DomainEventInput,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO domain_events (kind, entity_id, payload)
    VALUES (
      ${input.kind},
      ${input.entityId}::uuid,
      (${JSON.stringify(input.payload ?? {})}::text)::jsonb
    )
  `);
}
