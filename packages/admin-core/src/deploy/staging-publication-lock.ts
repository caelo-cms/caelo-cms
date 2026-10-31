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
 * lease (`deploy_leases`, migration 0393; the row mechanics are in
 * deploy-lease.ts). It used to be a transaction-scoped advisory lock, which
 * only worked because a Stage held one transaction across its whole build
 * and upload (#1211: that pinned a pooled connection for minutes and
 * starved the pool). Two kinds of holder share the row:
 *
 *   - A Stage and a Publish live of a build with its own staging host hold
 *     no transaction while they upload (#1211, #1225). They ACQUIRE the
 *     lease (`deploy.acquire_staging_publication`) and poll outside any
 *     transaction while it is held.
 *   - The preview keep-alive runs inside one short transaction. It LOCKS
 *     the row ({@link tryLockStagingPublication}) only while no run holds
 *     the lease, and skips its staging work while one does.
 *   - #1254 — the redirect sync CLAIMS the lease for the seconds of its
 *     push ({@link claimStagingPublicationForSync}) and holds no
 *     transaction while the provider answers; busy, it leaves staging
 *     behind.
 *
 * A later Stage waits for the earlier one and then supersedes it, which is
 * the order operators expect. Lock order against live-release-lock.ts is
 * fixed (live release first, then this) and a Stage never takes the
 * live-release lease, so the two cannot deadlock.
 *
 * Rolling update (#1211 review): while the previous release still serves
 * in-flight requests, its Stage, Publish live and keep-alive order
 * themselves by the transaction-scoped advisory lock
 * {@link LEGACY_STAGING_PUBLICATION_LOCK_KEY} and know nothing of the lease.
 * So this release honours that protocol too: a transaction holder also
 * takes the advisory lock (the previous release waits for it as before),
 * and a run acquires the lease only while no holder of the previous
 * release is in flight — neither the advisory lock nor a running site
 * build without a lease whose per-run lock is held. A run of the previous
 * release that only starts after this release's Stage acquired the lease
 * is not seen; the cutover leaves the previous revision nothing but its
 * in-flight requests, so that window is the seconds between one of them
 * arriving and reaching its first database step.
 *
 * The lease expires like every deploy lease (deploy-lease.ts).
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  claimLease,
  claimSyncLease,
  type DeployLeaseHolder,
  type LeaseRowLock,
  lockLeaseRow,
  previousReleaseRunInFlight,
  releaseLease,
  releaseSyncLease,
  renewLease,
  renewSyncLease,
  tryPreviousReleaseLock,
} from "./deploy-lease.js";

/** The lease's row name. Exported for the serialization regression tests. */
export const STAGING_PUBLICATION_LEASE = "staging-publication";

/**
 * The advisory-lock key the previous release ordered staging publications
 * by (a transaction-scoped `pg_advisory_xact_lock(hashtext(key))`). Kept
 * for rolling updates from it (see the file header).
 */
export const LEGACY_STAGING_PUBLICATION_LOCK_KEY = "caelo:staging-publication";

/** How long a Stage or Publish live waits for another one that is publishing staging. */
export const STAGING_PUBLICATION_WAIT_MS = 10 * 60_000;

/**
 * Inside a transaction: lock the lease row when no run holds the lease,
 * for the rest of this transaction. Waits for another transaction that
 * locked the row (like the advisory lock did); never waits for a run that
 * holds the lease — it reports that run instead.
 */
export async function tryLockStagingPublication(tx: TransactionRunner): Promise<LeaseRowLock> {
  // The previous release's protocol (file header): held until this
  // transaction ends, like that release held it. Not held: a transaction
  // of the previous release publishes right now (heldBy null).
  if (!(await tryPreviousReleaseLock(tx, LEGACY_STAGING_PUBLICATION_LOCK_KEY))) {
    return { locked: false, heldBy: null };
  }
  return lockLeaseRow(tx, STAGING_PUBLICATION_LEASE, { skipLocked: false });
}

/**
 * A run's side, in its own short transaction: take the lease for `runId`
 * when it is free, lapsed or already this run's. Never waits: a row another
 * transaction locked (the keep-alive, the redirect sync) counts as held.
 *
 * @returns acquired, or the holder (null: a transaction holds the row).
 */
export async function acquireStagingPublication(
  tx: TransactionRunner,
  args: { readonly runId: string; readonly ttlMs: number },
): Promise<
  | { readonly acquired: true }
  | { readonly acquired: false; readonly heldBy: DeployLeaseHolder | null }
> {
  // Rolling update (file header): wait while the previous release may
  // publish — it holds the advisory lock, or one of its site builds is in
  // flight (a running row without a lease whose run lock is held).
  if (!(await tryPreviousReleaseLock(tx, LEGACY_STAGING_PUBLICATION_LOCK_KEY))) {
    return { acquired: false, heldBy: null };
  }
  const inFlight = await previousReleaseRunInFlight(tx, {
    exceptRunId: args.runId,
    envs: ["staging", "production"],
    siteOnly: true,
  });
  if (inFlight !== null) {
    return { acquired: false, heldBy: { runId: inFlight, expiresAt: new Date().toISOString() } };
  }
  return claimLease(tx, STAGING_PUBLICATION_LEASE, args);
}

/** Push the lease's expiry forward while `runId` still holds it (see renewLease). */
export function renewStagingPublication(
  tx: TransactionRunner,
  args: { readonly runId: string; readonly ttlMs: number },
): Promise<"renewed" | "lost" | "not-held"> {
  return renewLease(tx, STAGING_PUBLICATION_LEASE, args);
}

/** Release the lease if `runId` holds it (see releaseLease). */
export function releaseStagingPublication(
  tx: TransactionRunner,
  runId: string,
): Promise<boolean | null> {
  return releaseLease(tx, STAGING_PUBLICATION_LEASE, runId);
}

/**
 * #1254 — the redirect sync's claim, in its own short transaction: take
 * the lease for `syncId` while nobody holds it, so the provider push that
 * follows (with no transaction open) never interleaves with a release of
 * the same channel. Never waits; false = someone holds it (that holder
 * syncs after its own release, the sync worker retries).
 */
export async function claimStagingPublicationForSync(
  tx: TransactionRunner,
  args: { readonly syncId: string; readonly ttlMs: number },
): Promise<boolean> {
  // The previous release's protocol (file header): its holder is in flight.
  if (!(await tryPreviousReleaseLock(tx, LEGACY_STAGING_PUBLICATION_LOCK_KEY))) return false;
  return claimSyncLease(tx, STAGING_PUBLICATION_LEASE, args);
}

/** Push a redirect sync's claim forward (see {@link claimStagingPublicationForSync}). */
export function renewStagingPublicationForSync(
  tx: TransactionRunner,
  args: { readonly syncId: string; readonly ttlMs: number },
): Promise<boolean> {
  return renewSyncLease(tx, STAGING_PUBLICATION_LEASE, args);
}

/** Release a redirect sync's claim (see {@link claimStagingPublicationForSync}). */
export function releaseStagingPublicationForSync(
  tx: TransactionRunner,
  syncId: string,
): Promise<void> {
  return releaseSyncLease(tx, STAGING_PUBLICATION_LEASE, syncId);
}
