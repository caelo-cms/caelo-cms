// SPDX-License-Identifier: MPL-2.0

/**
 * Orders every change to WHICH staged build the staging host serves (#650).
 *
 * A Stage publishes its preview channel, records it as the staging origin
 * (`staging_access.origin_url`) and deletes every other preview channel;
 * Publish live reads the origin and deletes every channel but that one.
 * Two of these interleaving would delete the channel the other one just
 * recorded: Stage A prunes B's fresh channel, then B records that deleted
 * channel as the origin — both report success and staging serves nothing.
 *
 * So the publish-record-prune sequence runs under the `staging-publication`
 * lease (`deploy_leases`, migration 0393). It used to be a transaction-
 * scoped advisory lock, which only worked because a Stage held one
 * transaction across its whole build and upload (#1211: that pinned a
 * pooled connection for minutes and starved the pool). Now two kinds of
 * holder share one row:
 *
 *   - A Stage holds no transaction while it uploads. It ACQUIRES the lease
 *     (`deploy.acquire_staging_publication`): its run id is committed into
 *     the row, renewed by the run's heartbeat, and released by the step that
 *     records the origin (or by the failure step). A Stage that finds the
 *     lease held polls outside any transaction.
 *   - Publish live, the preview keep-alive and the redirect sync still run
 *     inside one transaction. They LOCK the row ({@link lockStagingPublication},
 *     {@link tryLockStagingPublication}) only while no run holds the lease,
 *     and keep the row lock until their transaction ends. A Stage's acquire
 *     skips a row another transaction has locked (`SKIP LOCKED`), so it
 *     never waits on one with a connection in hand.
 *
 * A later Stage waits for the earlier one and then supersedes it, which is
 * the order operators expect. Lock order against live-release-lock.ts is
 * fixed (live release first, then this) and a Stage never takes the
 * live-release lock, so the two cannot deadlock.
 *
 * Rolling update (#1211 review): while the previous release still serves
 * in-flight requests, its Stage, Publish live and keep-alive order
 * themselves by the transaction-scoped advisory lock
 * {@link LEGACY_STAGING_PUBLICATION_LOCK_KEY} and know nothing of the lease.
 * So this release honours that protocol too: a transaction holder also
 * takes the advisory lock (the previous release waits for it as before),
 * and a Stage acquires the lease only while no holder of the previous
 * release is in flight — neither the advisory lock nor a running site
 * build without a lease whose per-run lock is held. A run of the previous
 * release that only starts after this release's Stage acquired the lease
 * is not seen; the cutover leaves the previous revision nothing but its
 * in-flight requests, so that window is the seconds between one of them
 * arriving and reaching its first database step.
 *
 * The lease expires: it guards a running process, not an editor's change
 * (CLAUDE.md §2's "locks never expire" is about the cross-branch entity
 * locks). A Stage whose instance died cannot release it; once its
 * heartbeat stops, the lease lapses and the next publish proceeds.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { DEPLOY_RUN_LOCK_PREFIX } from "./deploy-run-lock.js";

/** The lease's row name. Exported for the serialization regression tests. */
export const STAGING_PUBLICATION_LEASE = "staging-publication";

/**
 * The advisory-lock key the previous release ordered staging publications
 * by (a transaction-scoped `pg_advisory_xact_lock(hashtext(key))`). Kept
 * for rolling updates from it (see the file header).
 */
export const LEGACY_STAGING_PUBLICATION_LOCK_KEY = "caelo:staging-publication";

/** How long Publish live waits for a Stage that is publishing staging right now. */
export const STAGING_PUBLICATION_WAIT_MS = 10 * 60_000;

/** The run holding the lease. */
export interface StagingPublicationHolder {
  readonly runId: string;
  readonly expiresAt: string;
}

/** A Stage held the lease for the whole wait (Publish live's refusal). */
export class StagingPublicationBusyError extends Error {
  override readonly name = "StagingPublicationBusyError";
}

const toIso = (v: string | Date): string => (v instanceof Date ? v : new Date(v)).toISOString();

/** The row may not exist yet (a fresh install, the test reset): create it free. */
async function ensureLeaseRow(tx: TransactionRunner): Promise<void> {
  // ON CONFLICT DO NOTHING takes no lock on an existing row.
  await tx.execute(sql`
    INSERT INTO deploy_leases (name) VALUES (${STAGING_PUBLICATION_LEASE})
    ON CONFLICT (name) DO NOTHING
  `);
}

async function currentHolder(tx: TransactionRunner): Promise<StagingPublicationHolder | null> {
  const rows = (await tx.execute(sql`
    SELECT holder_run_id::text AS run_id, expires_at
    FROM deploy_leases
    WHERE name = ${STAGING_PUBLICATION_LEASE}
      AND holder_run_id IS NOT NULL AND expires_at > clock_timestamp()
  `)) as unknown as { run_id: string; expires_at: string | Date }[];
  const row = rows[0];
  return row ? { runId: row.run_id, expiresAt: toIso(row.expires_at) } : null;
}

/**
 * Inside a transaction: lock the lease row when no run holds the lease,
 * for the rest of this transaction. Waits for another transaction that
 * locked the row (like the advisory lock did); never waits for a run that
 * holds the lease — it reports that run instead.
 */
export async function tryLockStagingPublication(
  tx: TransactionRunner,
): Promise<
  { readonly locked: true } | { readonly locked: false; heldBy: StagingPublicationHolder | null }
> {
  // The previous release's protocol (file header): held until this
  // transaction ends, like that release held it. Not held: a transaction
  // of the previous release publishes right now (heldBy null).
  const legacy = (await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtext(${LEGACY_STAGING_PUBLICATION_LOCK_KEY})) AS free`,
  )) as unknown as { free: boolean }[];
  if (legacy[0]?.free !== true) return { locked: false, heldBy: null };
  await ensureLeaseRow(tx);
  // One statement tests and locks: an UPDATE locks only the row it matches,
  // and re-checks the condition on the newest version after a wait, so a
  // Stage that acquired the lease meanwhile leaves this transaction unlocked.
  const locked = (await tx.execute(sql`
    UPDATE deploy_leases SET name = name
    WHERE name = ${STAGING_PUBLICATION_LEASE}
      AND (holder_run_id IS NULL OR expires_at IS NULL OR expires_at <= clock_timestamp())
    RETURNING 1 AS locked
  `)) as unknown as { locked: number }[];
  if (locked.length > 0) return { locked: true };
  const heldBy = await currentHolder(tx);
  // Lapsed between the two statements: the next call locks it.
  if (heldBy === null) return tryLockStagingPublication(tx);
  return { locked: false, heldBy };
}

/**
 * Publish live's side: wait (polling, without holding the row) until no
 * Stage holds the lease, then lock the row until this transaction ends.
 * Throws {@link StagingPublicationBusyError} when a Stage held it for
 * `waitMs`.
 */
export async function lockStagingPublication(
  tx: TransactionRunner,
  opts: { readonly waitMs?: number; readonly sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const waitMs = opts.waitMs ?? STAGING_PUBLICATION_WAIT_MS;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + waitMs;
  let pause = 100;
  for (;;) {
    const r = await tryLockStagingPublication(tx);
    if (r.locked) return;
    if (Date.now() >= deadline) {
      throw new StagingPublicationBusyError(
        `a Stage is publishing the staging site right now (${r.heldBy ? `build ${r.heldBy.runId}` : "a run of the previous Caelo version, during the update"}) and did not finish within ${Math.round(waitMs / 1000)} s. Nothing was published; Publish live again once that Stage finished (Settings → Deployments shows it).`,
      );
    }
    await sleep(pause);
    pause = Math.min(pause * 2, 2_000);
  }
}

/**
 * A Stage's side, in its own short transaction: take the lease for `runId`
 * when it is free, lapsed or already this run's. Never waits: a row another
 * transaction locked (Publish live, the keep-alive) counts as held.
 *
 * @returns acquired, or the holder (null: a transaction holds the row).
 */
export async function acquireStagingPublication(
  tx: TransactionRunner,
  args: { readonly runId: string; readonly ttlMs: number },
): Promise<
  | { readonly acquired: true }
  | { readonly acquired: false; readonly heldBy: StagingPublicationHolder | null }
> {
  // Rolling update (file header): wait while the previous release may
  // publish — it holds the advisory lock, or one of its site builds is in
  // flight (a running row without a lease whose run lock is held).
  const legacyLock = (await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtext(${LEGACY_STAGING_PUBLICATION_LOCK_KEY})) AS free`,
  )) as unknown as { free: boolean }[];
  if (legacyLock[0]?.free !== true) return { acquired: false, heldBy: null };
  const legacyRun = (await tx.execute(sql`
    SELECT r.id::text AS run_id
    FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
    WHERE r.status = 'running' AND r.lease_expires_at IS NULL AND r.build_kind = 'site'
      AND t.env IN ('staging', 'production') AND r.id <> ${args.runId}::uuid
      AND NOT pg_try_advisory_xact_lock(hashtext(${DEPLOY_RUN_LOCK_PREFIX} || r.id::text))
    LIMIT 1
  `)) as unknown as { run_id: string }[];
  const inFlight = legacyRun[0];
  if (inFlight) {
    return {
      acquired: false,
      heldBy: { runId: inFlight.run_id, expiresAt: new Date().toISOString() },
    };
  }
  await ensureLeaseRow(tx);
  const rows = (await tx.execute(sql`
    SELECT holder_run_id::text AS run_id, expires_at,
           (holder_run_id IS NULL OR expires_at IS NULL OR expires_at <= clock_timestamp()
            OR holder_run_id = ${args.runId}::uuid) AS claimable
    FROM deploy_leases
    WHERE name = ${STAGING_PUBLICATION_LEASE}
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
        acquired_at = clock_timestamp(),
        expires_at = clock_timestamp() + ${args.ttlMs}::int * interval '1 millisecond'
    WHERE name = ${STAGING_PUBLICATION_LEASE}
  `);
  return { acquired: true };
}

/**
 * Push the lease's expiry forward while `runId` still holds it unexpired.
 *
 * @returns "renewed"; "lost" when this run held it but it lapsed (another
 *   publish may have run meanwhile); "not-held" when it is not this run's.
 */
export async function renewStagingPublication(
  tx: TransactionRunner,
  args: { readonly runId: string; readonly ttlMs: number },
): Promise<"renewed" | "lost" | "not-held"> {
  const rows = (await tx.execute(sql`
    UPDATE deploy_leases
    SET expires_at = CASE WHEN expires_at > clock_timestamp()
                          THEN clock_timestamp() + ${args.ttlMs}::int * interval '1 millisecond'
                          ELSE expires_at END
    WHERE name = ${STAGING_PUBLICATION_LEASE} AND holder_run_id = ${args.runId}::uuid
    RETURNING expires_at > clock_timestamp() AS live
  `)) as unknown as { live: boolean }[];
  const row = rows[0];
  if (!row) return "not-held";
  return row.live ? "renewed" : "lost";
}

/**
 * Release whatever lease `runId` holds, in the caller's transaction (which
 * keeps the row locked until it commits, so a sync later in the same
 * transaction sees the lease free and nobody else gets in between).
 *
 * @returns whether the run still held it unexpired, or null when it held
 *   nothing.
 */
export async function releaseStagingPublication(
  tx: TransactionRunner,
  runId: string,
): Promise<boolean | null> {
  const rows = (await tx.execute(sql`
    SELECT expires_at > clock_timestamp() AS live
    FROM deploy_leases
    WHERE name = ${STAGING_PUBLICATION_LEASE} AND holder_run_id = ${runId}::uuid
    FOR UPDATE
  `)) as unknown as { live: boolean }[];
  const row = rows[0];
  if (!row) return null;
  await tx.execute(sql`
    UPDATE deploy_leases SET holder_run_id = NULL, acquired_at = NULL, expires_at = NULL
    WHERE name = ${STAGING_PUBLICATION_LEASE} AND holder_run_id = ${runId}::uuid
  `);
  return row.live;
}
