// SPDX-License-Identifier: MPL-2.0

/**
 * Orders every write to the live channel of the static site.
 *
 * Publish live (`deploy.promote`), rollback and the plugin-data build
 * release a new version on the live channel. The Firebase custom-domain CDN
 * purge (firebase-custom-domain.ts) also creates a live release: it reads
 * the version that is live and releases it again. The redirect sync puts
 * the redirects table on the build the live target serves. Without
 * ordering, a publish that lands between the purge's read and its release
 * is silently undone — the purge re-releases the version the publish just
 * replaced, while deploy_runs says the new build is live.
 *
 * So they share the `live-release` lease (`deploy_leases`, migration 0402;
 * the row mechanics are in deploy-lease.ts). It used to be the
 * transaction-scoped advisory lock {@link LEGACY_LIVE_RELEASE_LOCK_KEY},
 * which only worked because Publish live held one transaction across its
 * whole rebuild and upload (#1225: that pinned a pooled connection for
 * minutes, the deadlock class of #1209). Two kinds of holder now share one
 * row:
 *
 *   - Publish live and the plugin-data build hold no transaction while they
 *     build and upload. They ACQUIRE the lease (`deploy.acquire_live_release`)
 *     as their run: Publish live polls outside any transaction while it is
 *     held, the plugin-data tick skips (its marks stay pending for the next
 *     tick).
 *   - Rollback and the CDN purge run inside one short transaction. They
 *     LOCK the row ({@link tryLockLiveRelease}) only while no run holds the
 *     lease and keep it until their transaction ends. Rollback waits for a
 *     free lease OUTSIDE its transaction and then tries again; the purge
 *     skips (the publish's own release purges the CDN, and the purge
 *     retries on the next status read).
 *   - #1254 — the redirect sync CLAIMS the lease for the seconds of its
 *     push ({@link claimLiveReleaseForSync}) and holds no transaction while
 *     the provider answers. Busy: it leaves production behind (the holder's
 *     finish step syncs it, the worker retries).
 *
 * Lock order: live release first, then the staging publication
 * (staging-publication-lock.ts). A Stage never takes this lease, so the two
 * cannot deadlock.
 *
 * Rolling update (#1225): while the previous release still serves in-flight
 * requests, its Publish live, rollback, plugin-data build, redirect sync
 * and CDN purge order themselves by the advisory lock and know nothing of
 * the lease. So every holder of this release also takes the advisory lock
 * (try-only; not free = the previous release publishes right now, treated
 * like a held lease), and a run claims the lease only while no holder of
 * the previous release is in flight — neither the advisory lock nor a
 * running production build without a lease whose per-run lock is held. A
 * holder of the previous release that only starts after this release's run
 * claimed the lease is not seen; the cutover leaves the previous revision
 * nothing but its in-flight requests (and timers until its instances stop),
 * so that window is the seconds between one of them arriving and reaching
 * its first database step.
 *
 * The redirect sync's claim (#1254) is the one holder the previous release
 * cannot see at all: it reads only `holder_run_id`, and a sync holds the
 * lease by `holder_sync_id`, so its rollback and CDN purge (row lock only)
 * would read the lease as free. Its own claims fail on the
 * `deploy_leases_one_holder` CHECK. Rollback (a click) and the purge (a
 * status read) are both request-driven in that release, so the exposure is
 * the same window as above: a request already in flight on the previous
 * revision at cutover, overlapping the seconds of a sync's push.
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
export const LIVE_RELEASE_LEASE = "live-release";

/**
 * The advisory-lock key the previous release ordered live releases by (a
 * transaction-scoped `pg_advisory_xact_lock(hashtext(key))`). Kept for
 * rolling updates from it (see the file header).
 */
export const LEGACY_LIVE_RELEASE_LOCK_KEY = "caelo:static-live-release";

/** How long Publish live and rollback wait for another live release to finish. */
export const LIVE_RELEASE_WAIT_MS = 10 * 60_000;

/**
 * Inside a transaction: lock the lease row while no run holds the lease,
 * for the rest of this transaction. Never waits for a run — it reports that
 * run instead. `skipLocked` (rollback, the purge): also never wait for
 * another transaction that locked the row; otherwise (the redirect sync)
 * wait for it, like the advisory lock did.
 */
export async function tryLockLiveRelease(
  tx: TransactionRunner,
  opts: { readonly skipLocked: boolean },
): Promise<LeaseRowLock> {
  if (!(await tryPreviousReleaseLock(tx, LEGACY_LIVE_RELEASE_LOCK_KEY))) {
    return { locked: false, heldBy: null };
  }
  return lockLeaseRow(tx, LIVE_RELEASE_LEASE, opts);
}

/**
 * Purge side: true when this transaction now holds the live-release row;
 * false while a publish (or another purge) holds it — the caller then skips
 * the purge.
 */
export async function tryLockLiveReleases(tx: TransactionRunner): Promise<boolean> {
  return (await tryLockLiveRelease(tx, { skipLocked: true })).locked;
}

/**
 * A run's side, in its own short transaction: take the lease for `runId`
 * when it is free, lapsed or already this run's. Never waits.
 *
 * @returns acquired, or the holder (null: a transaction holds the row, or
 *   a holder of the previous release is in flight).
 */
export async function acquireLiveRelease(
  tx: TransactionRunner,
  args: { readonly runId: string; readonly ttlMs: number },
): Promise<
  | { readonly acquired: true }
  | { readonly acquired: false; readonly heldBy: DeployLeaseHolder | null }
> {
  if (!(await tryPreviousReleaseLock(tx, LEGACY_LIVE_RELEASE_LOCK_KEY))) {
    return { acquired: false, heldBy: null };
  }
  // The previous release's Publish live commits its run row before it takes
  // the advisory lock: its run lock tells it is in flight meanwhile.
  const inFlight = await previousReleaseRunInFlight(tx, {
    exceptRunId: args.runId,
    envs: ["production"],
    siteOnly: false,
  });
  if (inFlight !== null) {
    return { acquired: false, heldBy: { runId: inFlight, expiresAt: new Date().toISOString() } };
  }
  return claimLease(tx, LIVE_RELEASE_LEASE, args);
}

/** Push the lease's expiry forward while `runId` still holds it (see renewLease). */
export function renewLiveRelease(
  tx: TransactionRunner,
  args: { readonly runId: string; readonly ttlMs: number },
): Promise<"renewed" | "lost" | "not-held"> {
  return renewLease(tx, LIVE_RELEASE_LEASE, args);
}

/** Release the lease if `runId` holds it (see releaseLease). */
export function releaseLiveRelease(tx: TransactionRunner, runId: string): Promise<boolean | null> {
  return releaseLease(tx, LIVE_RELEASE_LEASE, runId);
}

/**
 * #1254 — the redirect sync's claim, in its own short transaction: take
 * the lease for `syncId` while nobody holds it, so the provider push that
 * follows (with no transaction open) never interleaves with a release of
 * the same channel. Never waits; false = someone holds it (that holder
 * syncs after its own release, the sync worker retries).
 */
export async function claimLiveReleaseForSync(
  tx: TransactionRunner,
  args: { readonly syncId: string; readonly ttlMs: number },
): Promise<boolean> {
  // The previous release's protocol (file header): its holder is in flight.
  if (!(await tryPreviousReleaseLock(tx, LEGACY_LIVE_RELEASE_LOCK_KEY))) return false;
  return claimSyncLease(tx, LIVE_RELEASE_LEASE, args);
}

/** Push a redirect sync's claim forward (see {@link claimLiveReleaseForSync}). */
export function renewLiveReleaseForSync(
  tx: TransactionRunner,
  args: { readonly syncId: string; readonly ttlMs: number },
): Promise<boolean> {
  return renewSyncLease(tx, LIVE_RELEASE_LEASE, args);
}

/** Release a redirect sync's claim (see {@link claimLiveReleaseForSync}). */
export function releaseLiveReleaseForSync(tx: TransactionRunner, syncId: string): Promise<void> {
  return releaseSyncLease(tx, LIVE_RELEASE_LEASE, syncId);
}
