// SPDX-License-Identifier: MPL-2.0

/**
 * issue #264 — per-entity sub-leases within a shared chat branch.
 *
 * The branch lock (`locks.ts`) keys on the branch SESSION. Parallel
 * sibling subagents (the #264 fan-out) all run on the PARENT chat's
 * branch via `chatBranchIdOverride`, so every sibling resolves to the
 * SAME session and the branch lock permits ALL of them to write the SAME
 * entity — a silent last-writer-wins lost update, not a clean failure.
 *
 * This module adds a second, finer guard ON TOP of the branch lock: a
 * short-TTL lease keyed on (entity, branch) whose holder is the acquiring
 * writer's OWN session (`ctx.chatTaskId`). Two writers on the same branch
 * are the SAME holder only when they are the same session (the parent
 * orchestrator making sequential edits); sibling subagents each carry
 * their own ephemeral session id, so a sibling touching an entity another
 * sibling already holds is refused cleanly. The branch lock is untouched:
 * subagents still share the parent's preview/publish/undo scope.
 *
 * Leases carry a TTL so a died / timed-out subagent never wedges an
 * entity — an expired lease is treated as free and taken over. Leases are
 * also released explicitly on `subagent_runs.finish` (by holder) and on
 * chat publish / discard (by branch).
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import type { LockedEntityKind } from "./locks.js";

/** Default lease lifetime. Overridable via `CAELO_ENTITY_LEASE_TTL_MS`. */
export const DEFAULT_ENTITY_LEASE_TTL_MS = 120_000;

/**
 * Resolve the configured lease TTL. Falls back to the 2-minute default
 * for an unset / non-numeric / non-positive env value.
 */
export function entityLeaseTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CAELO_ENTITY_LEASE_TTL_MS;
  if (raw === undefined) return DEFAULT_ENTITY_LEASE_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ENTITY_LEASE_TTL_MS;
}

/** Who currently holds a lease, for the refusal error. */
export interface LeaseHolder {
  holderKey: string;
  expiresAt: string;
}

/** An existing lease row as read back from the store. */
export interface ExistingLease {
  holderKey: string;
  expiresAt: Date;
}

/**
 * Pure lease decision. Given the current lease row (or `null`) plus the
 * would-be holder and clock, decide whether the caller acquires a fresh
 * lease, refreshes its own, or is refused because a live sibling holds it.
 *
 * Kept side-effect-free and clock-injectable so the acquire / refresh /
 * expiry / refuse branches are exhaustively unit-testable without a DB.
 * The DB wrapper below serializes concurrent callers with `FOR UPDATE`
 * before applying this decision, so it stays race-safe under READ
 * COMMITTED.
 *
 * @param existing current lease for (entity, branch), or null if none
 * @param holderKey the caller's own session id (`ctx.chatTaskId`)
 * @param now injected clock
 * @param ttlMs lease lifetime; `expiresAt` on acquire/refresh is `now + ttlMs`
 */
export function evaluateLease(args: {
  existing: ExistingLease | null;
  holderKey: string;
  now: Date;
  ttlMs: number;
}):
  | { kind: "acquire"; expiresAt: Date }
  | { kind: "refresh"; expiresAt: Date }
  | { kind: "refuse"; holder: LeaseHolder } {
  const expiresAt = new Date(args.now.getTime() + args.ttlMs);
  const { existing, holderKey, now } = args;
  if (existing === null) {
    return { kind: "acquire", expiresAt };
  }
  if (existing.holderKey === holderKey) {
    // Same writer re-touching the entity: no-op refresh, extends the TTL.
    return { kind: "refresh", expiresAt };
  }
  if (existing.expiresAt.getTime() <= now.getTime()) {
    // A died / timed-out holder's lease has lapsed — take it over.
    return { kind: "acquire", expiresAt };
  }
  return {
    kind: "refuse",
    holder: { holderKey: existing.holderKey, expiresAt: existing.expiresAt.toISOString() },
  };
}

/** Result of a lease acquisition attempt. */
export interface LeaseAcquireResult {
  /** True iff the caller now holds the lease (acquired or refreshed). */
  acquired: boolean;
  /** Set when `acquired=false`: the live sibling holder that blocked us. */
  holder?: LeaseHolder;
}

/**
 * Acquire (or refresh) the sub-lease for (kind, entityId, branchId) as
 * `holderKey`. Race-safe: a `FOR UPDATE` row lock serializes concurrent
 * transactions on the same (entity, branch) before {@link evaluateLease}
 * decides, so two siblings racing on a fresh entity resolve to exactly
 * one winner.
 *
 * @returns `{ acquired: true }` when the caller holds the lease, or
 * `{ acquired: false, holder }` when a live sibling holds it.
 */
export async function acquireEntityLease(
  tx: TransactionRunner,
  args: {
    kind: LockedEntityKind;
    entityId: string;
    branchId: string;
    holderKey: string;
    now?: Date;
    ttlMs?: number;
  },
): Promise<LeaseAcquireResult> {
  const now = args.now ?? new Date();
  const ttlMs = args.ttlMs ?? entityLeaseTtlMs();
  const initialExpiry = new Date(now.getTime() + ttlMs);

  // 1. Claim the slot if it is free. DO NOTHING leaves an existing row
  //    (ours, a live sibling's, or an expired one) untouched.
  await tx.execute(sql`
    INSERT INTO entity_leases (entity_kind, entity_id, branch_id, holder_key, acquired_at, expires_at)
    VALUES (${args.kind}, ${args.entityId}::uuid, ${args.branchId}::uuid,
            ${args.holderKey}, ${now.toISOString()}::timestamptz, ${initialExpiry.toISOString()}::timestamptz)
    ON CONFLICT (entity_kind, entity_id, branch_id) DO NOTHING
  `);

  // 2. Lock the now-guaranteed row so a concurrent sibling blocks here
  //    until we commit, then re-reads the latest committed holder.
  const rows = (await tx.execute(sql`
    SELECT holder_key, expires_at
    FROM entity_leases
    WHERE entity_kind = ${args.kind} AND entity_id = ${args.entityId}::uuid
      AND branch_id = ${args.branchId}::uuid
    FOR UPDATE
  `)) as unknown as { holder_key: string; expires_at: string | Date }[];
  const row = rows[0];
  const existing: ExistingLease | null = row
    ? {
        holderKey: row.holder_key,
        expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
      }
    : null;

  const decision = evaluateLease({ existing, holderKey: args.holderKey, now, ttlMs });
  if (decision.kind === "refuse") {
    return { acquired: false, holder: decision.holder };
  }

  // acquire (fresh / expired takeover) or refresh (same holder): stamp
  // our holder + extend the TTL. Idempotent for the row we just inserted.
  await tx.execute(sql`
    UPDATE entity_leases
    SET holder_key = ${args.holderKey},
        acquired_at = ${now.toISOString()}::timestamptz,
        expires_at = ${decision.expiresAt.toISOString()}::timestamptz
    WHERE entity_kind = ${args.kind} AND entity_id = ${args.entityId}::uuid
      AND branch_id = ${args.branchId}::uuid
  `);
  return { acquired: true };
}

/**
 * Structured refusal when a sibling task on the same branch already holds
 * the entity. The message names the disjointness violation and the next
 * step so the AI surfaces "your task set overlaps" rather than retrying.
 */
export function siblingLeaseError(
  operation: string,
  kind: LockedEntityKind,
  entityId: string,
  holder: LeaseHolder,
): {
  kind: "SiblingLeaseConflict";
  operation: string;
  message: string;
  entityKind: LockedEntityKind;
  entityId: string;
  holder: LeaseHolder;
} {
  return {
    kind: "SiblingLeaseConflict",
    operation,
    message:
      `${kind} ${entityId} is being edited by a sibling task on the same branch ` +
      `(lease held until ${holder.expiresAt}); your task set overlaps — this is a ` +
      `disjointness violation. Leave this entity to the task that owns it and rebuild ` +
      `only the pages/modules assigned to you.`,
    entityKind: kind,
    entityId,
    holder,
  };
}

/**
 * Release every lease held by `holderKey`. Called on `subagent_runs.finish`
 * so a completed / errored / timed-out subagent frees its entities
 * immediately instead of waiting out the TTL.
 */
export async function releaseLeasesByHolder(
  tx: TransactionRunner,
  holderKey: string,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM entity_leases WHERE holder_key = ${holderKey}
  `);
}

/**
 * Release every lease on `branchId`. Called when a chat publishes or is
 * discarded — the branch is gone, so any residual sibling leases on it
 * (e.g. an orphaned subagent that never finished) are cleared too.
 */
export async function releaseLeasesByBranch(
  tx: TransactionRunner,
  branchId: string,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM entity_leases WHERE branch_id = ${branchId}::uuid
  `);
}
