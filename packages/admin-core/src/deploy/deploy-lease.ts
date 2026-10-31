// SPDX-License-Identifier: MPL-2.0

/**
 * Named publish leases (`deploy_leases`, migrations 0393 / 0402) — the
 * row operations both leases share. What each lease orders, and how it
 * honours the previous release's advisory lock during a rolling update,
 * lives with the lease: staging-publication-lock.ts, live-release-lock.ts.
 *
 * Two kinds of holder share one row:
 *
 *   - a deploy run that holds NO transaction while it builds and uploads
 *     (Stage, Publish live, the plugin-data build) CLAIMS the lease: its
 *     run id is committed into the row, renewed by the run's heartbeat and
 *     released by the step that records the run (or by deploy.fail_run).
 *     A run that finds the lease held polls outside any transaction;
 *   - a short transaction (rollback, the preview keep-alive, the CDN
 *     purge) LOCKS the row while no run holds the lease, until it ends.
 *   - #1254 — the redirect sync CLAIMS the lease by its own id
 *     (`holder_sync_id`) in a short transaction, pushes to the provider
 *     with no transaction open and releases it: it holds the lease for
 *     seconds, never a row lock across network I/O. A run's claim skips a row another transaction
 *     has locked (`SKIP LOCKED`), so it never waits with a connection in
 *     hand.
 *
 * A lease expires: it guards a running process, not an editor's change
 * (CLAUDE.md §2's "locks never expire" is about the cross-branch entity
 * locks). A run whose instance died cannot release it; once its heartbeat
 * stops the lease lapses on the database clock and the next holder
 * proceeds.
 */

import { type TransactionRunner, textArray } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { DEPLOY_RUN_LOCK_PREFIX } from "./deploy-run-lock.js";

/** The leases migration 0402's CHECK admits. */
export type DeployLeaseName = "staging-publication" | "live-release";

/** The run holding a lease. */
export interface DeployLeaseHolder {
  readonly runId: string;
  readonly expiresAt: string;
}

/** A transaction's attempt to lock a lease row ({@link lockLeaseRow}). */
export type LeaseRowLock =
  | { readonly locked: true }
  | {
      readonly locked: false;
      /** The run holding the lease; null when another transaction holds the row (or the previous release does). */
      readonly heldBy: DeployLeaseHolder | null;
    };

const toIso = (v: string | Date): string => (v instanceof Date ? v : new Date(v)).toISOString();

/**
 * A lease row nobody holds: no run and no redirect sync (#1254, migration
 * 0457) claimed it, or the claim lapsed.
 */
const FREE_SQL = sql`(
  (holder_run_id IS NULL AND holder_sync_id IS NULL)
  OR expires_at IS NULL OR expires_at <= clock_timestamp()
)`;

/** Whether a redirect sync holds `name` unexpired. */
async function syncHoldsLease(tx: TransactionRunner, name: DeployLeaseName): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT 1 AS held FROM deploy_leases
    WHERE name = ${name} AND holder_sync_id IS NOT NULL AND expires_at > clock_timestamp()
  `)) as unknown as { held: number }[];
  return rows.length > 0;
}

/** The row may not exist yet (a fresh install, the test reset): create it free. */
export async function ensureLeaseRow(tx: TransactionRunner, name: DeployLeaseName): Promise<void> {
  // ON CONFLICT DO NOTHING takes no lock on an existing row.
  await tx.execute(sql`
    INSERT INTO deploy_leases (name) VALUES (${name})
    ON CONFLICT (name) DO NOTHING
  `);
}

/** The run holding `name` unexpired, or null. */
export async function leaseHolder(
  tx: TransactionRunner,
  name: DeployLeaseName,
): Promise<DeployLeaseHolder | null> {
  const rows = (await tx.execute(sql`
    SELECT holder_run_id::text AS run_id, expires_at
    FROM deploy_leases
    WHERE name = ${name}
      AND holder_run_id IS NOT NULL AND expires_at > clock_timestamp()
  `)) as unknown as { run_id: string; expires_at: string | Date }[];
  const row = rows[0];
  return row ? { runId: row.run_id, expiresAt: toIso(row.expires_at) } : null;
}

/**
 * Inside a transaction: lock the row of `name` while no run holds the
 * lease, for the rest of this transaction. `skipLocked`: never wait for
 * another transaction that locked the row (it counts as held); otherwise
 * wait for it, like the advisory lock this replaces did. Never waits for a
 * run that holds the lease — it reports that run instead.
 */
export async function lockLeaseRow(
  tx: TransactionRunner,
  name: DeployLeaseName,
  opts: { readonly skipLocked: boolean },
): Promise<LeaseRowLock> {
  await ensureLeaseRow(tx, name);
  if (opts.skipLocked) {
    const rows = (await tx.execute(sql`
      SELECT holder_run_id::text AS run_id, expires_at,
             ${FREE_SQL} AS free
      FROM deploy_leases WHERE name = ${name}
      FOR UPDATE SKIP LOCKED
    `)) as unknown as { run_id: string | null; expires_at: string | Date | null; free: boolean }[];
    const row = rows[0];
    if (!row) return { locked: false, heldBy: null };
    if (row.free) return { locked: true };
    return {
      locked: false,
      heldBy:
        row.run_id !== null && row.expires_at !== null
          ? { runId: row.run_id, expiresAt: toIso(row.expires_at) }
          : null,
    };
  }
  // One statement tests and locks: an UPDATE locks only the row it matches,
  // and re-checks the condition on the newest version after a wait, so a
  // run that claimed the lease meanwhile leaves this transaction unlocked.
  const locked = (await tx.execute(sql`
    UPDATE deploy_leases SET name = name
    WHERE name = ${name} AND ${FREE_SQL}
    RETURNING 1 AS locked
  `)) as unknown as { locked: number }[];
  if (locked.length > 0) return { locked: true };
  const heldBy = await leaseHolder(tx, name);
  if (heldBy !== null) return { locked: false, heldBy };
  // #1254 — a redirect sync holds it (seconds): reported like a held row.
  if (await syncHoldsLease(tx, name)) return { locked: false, heldBy: null };
  // Lapsed between the two statements: the next call locks it.
  return lockLeaseRow(tx, name, opts);
}

/**
 * A run's side, in its own short transaction: take `name` for `runId` when
 * it is free, lapsed or already this run's. Never waits: a row another
 * transaction locked counts as held.
 *
 * @returns acquired, or the holder (null: a transaction holds the row).
 */
export async function claimLease(
  tx: TransactionRunner,
  name: DeployLeaseName,
  args: { readonly runId: string; readonly ttlMs: number },
): Promise<
  | { readonly acquired: true }
  | { readonly acquired: false; readonly heldBy: DeployLeaseHolder | null }
> {
  await ensureLeaseRow(tx, name);
  const rows = (await tx.execute(sql`
    SELECT holder_run_id::text AS run_id, expires_at,
           (${FREE_SQL} OR holder_run_id = ${args.runId}::uuid) AS claimable
    FROM deploy_leases
    WHERE name = ${name}
    FOR UPDATE SKIP LOCKED
  `)) as unknown as {
    run_id: string | null;
    expires_at: string | Date | null;
    claimable: boolean;
  }[];
  const row = rows[0];
  if (!row) return { acquired: false, heldBy: null };
  if (!row.claimable) {
    return {
      acquired: false,
      heldBy:
        row.run_id !== null && row.expires_at !== null
          ? { runId: row.run_id, expiresAt: toIso(row.expires_at) }
          : null,
    };
  }
  await tx.execute(sql`
    UPDATE deploy_leases
    SET holder_run_id = ${args.runId}::uuid,
        holder_sync_id = NULL,
        acquired_at = clock_timestamp(),
        expires_at = clock_timestamp() + ${args.ttlMs}::int * interval '1 millisecond'
    WHERE name = ${name}
  `);
  return { acquired: true };
}

/**
 * Push the lease's expiry forward while `runId` still holds it unexpired.
 *
 * @returns "renewed"; "lost" when this run held it but it lapsed (another
 *   holder may have run meanwhile); "not-held" when it is not this run's.
 */
export async function renewLease(
  tx: TransactionRunner,
  name: DeployLeaseName,
  args: { readonly runId: string; readonly ttlMs: number },
): Promise<"renewed" | "lost" | "not-held"> {
  const rows = (await tx.execute(sql`
    UPDATE deploy_leases
    SET expires_at = CASE WHEN expires_at > clock_timestamp()
                          THEN clock_timestamp() + ${args.ttlMs}::int * interval '1 millisecond'
                          ELSE expires_at END
    WHERE name = ${name} AND holder_run_id = ${args.runId}::uuid
    RETURNING expires_at > clock_timestamp() AS live
  `)) as unknown as { live: boolean }[];
  const row = rows[0];
  if (!row) return "not-held";
  return row.live ? "renewed" : "lost";
}

/**
 * Release `name` if `runId` holds it, in the caller's transaction (which
 * keeps the row locked until it commits, so a sync later in the same
 * transaction sees the lease free and nobody else gets in between).
 *
 * @returns whether the run still held it unexpired, or null when it held
 *   nothing.
 */
export async function releaseLease(
  tx: TransactionRunner,
  name: DeployLeaseName,
  runId: string,
): Promise<boolean | null> {
  const rows = (await tx.execute(sql`
    SELECT expires_at > clock_timestamp() AS live
    FROM deploy_leases
    WHERE name = ${name} AND holder_run_id = ${runId}::uuid
    FOR UPDATE
  `)) as unknown as { live: boolean }[];
  const row = rows[0];
  if (!row) return null;
  await tx.execute(sql`
    UPDATE deploy_leases SET holder_run_id = NULL, acquired_at = NULL, expires_at = NULL
    WHERE name = ${name} AND holder_run_id = ${runId}::uuid
  `);
  return row.live;
}

/**
 * Rolling update (#1211, #1225): a deploy run of the previous release that
 * is in flight right now — a `running` row without a lease (that release
 * builds inside one transaction) whose per-run advisory lock is held. Such
 * a run knows nothing of the leases, so a run of this release claims none
 * while one is in flight.
 *
 * @param args.envs - only runs of targets in these environments.
 * @param args.siteOnly - only site builds (the previous release's
 *   plugin-data build holds the live-release advisory lock instead).
 * @returns the run id, or null.
 */
export async function previousReleaseRunInFlight(
  tx: TransactionRunner,
  args: {
    readonly exceptRunId: string;
    readonly envs: readonly ("staging" | "production")[];
    readonly siteOnly: boolean;
  },
): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT r.id::text AS run_id
    FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
    WHERE r.status = 'running' AND r.lease_expires_at IS NULL
      ${args.siteOnly ? sql`AND r.build_kind = 'site'` : sql``}
      AND t.env = ANY(${textArray(args.envs)})
      AND r.id <> ${args.exceptRunId}::uuid
      AND NOT pg_try_advisory_xact_lock(hashtext(${DEPLOY_RUN_LOCK_PREFIX} || r.id::text))
    LIMIT 1
  `)) as unknown as { run_id: string }[];
  return rows[0]?.run_id ?? null;
}

/**
 * Rolling update: TRY the previous release's transaction-scoped advisory
 * lock `key` for the rest of this transaction (that release waits for it
 * as before). False: a transaction of the previous release holds it.
 */
export async function tryPreviousReleaseLock(tx: TransactionRunner, key: string): Promise<boolean> {
  const rows = (await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS free`,
  )) as unknown as { free: boolean }[];
  return rows[0]?.free === true;
}

/**
 * #1254 — the redirect sync's side, in its own short transaction: take
 * `name` for the sync `syncId` when it is free or lapsed. Never waits: a row
 * another transaction locked, or a run holding the lease, counts as held.
 * The sync then pushes with no transaction open and releases the lease with
 * {@link releaseSyncLease}; it is not a deploy run, so it holds the lease
 * by its own id (`holder_sync_id`, migration 0457).
 */
export async function claimSyncLease(
  tx: TransactionRunner,
  name: DeployLeaseName,
  args: { readonly syncId: string; readonly ttlMs: number },
): Promise<boolean> {
  await ensureLeaseRow(tx, name);
  const rows = (await tx.execute(sql`
    SELECT ${FREE_SQL} AS claimable FROM deploy_leases
    WHERE name = ${name}
    FOR UPDATE SKIP LOCKED
  `)) as unknown as { claimable: boolean }[];
  if (rows[0]?.claimable !== true) return false;
  await tx.execute(sql`
    UPDATE deploy_leases
    SET holder_run_id = NULL,
        holder_sync_id = ${args.syncId}::uuid,
        acquired_at = clock_timestamp(),
        expires_at = clock_timestamp() + ${args.ttlMs}::int * interval '1 millisecond'
    WHERE name = ${name}
  `);
  return true;
}

/** Push a sync's claim forward while it still holds it unexpired. */
export async function renewSyncLease(
  tx: TransactionRunner,
  name: DeployLeaseName,
  args: { readonly syncId: string; readonly ttlMs: number },
): Promise<boolean> {
  const rows = (await tx.execute(sql`
    UPDATE deploy_leases
    SET expires_at = clock_timestamp() + ${args.ttlMs}::int * interval '1 millisecond'
    WHERE name = ${name} AND holder_sync_id = ${args.syncId}::uuid
      AND expires_at > clock_timestamp()
    RETURNING 1 AS renewed
  `)) as unknown as { renewed: number }[];
  return rows.length > 0;
}

/** Release `name` if the sync `syncId` still holds it. */
export async function releaseSyncLease(
  tx: TransactionRunner,
  name: DeployLeaseName,
  syncId: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE deploy_leases SET holder_sync_id = NULL, acquired_at = NULL, expires_at = NULL
    WHERE name = ${name} AND holder_sync_id = ${syncId}::uuid
  `);
}
