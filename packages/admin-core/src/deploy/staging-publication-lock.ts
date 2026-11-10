// SPDX-License-Identifier: MPL-2.0

/**
 * Orders every change to WHICH staged build the staging host serves (#650,
 * #1330).
 *
 * A Stage fills the staging slot staging does not serve and then records
 * it as served (`staging_access.served_location`). Two Stages doing that
 * at once would fill the same slot with a mix of both builds. So a Stage
 * holds the `staging-publication` lease (`deploy_leases`, migration 0393;
 * the row mechanics are in deploy-lease.ts) from before its upload opens
 * until the transaction that records it: it ACQUIRES the lease
 * (`deploy.acquire_staging_publication`) and polls outside any transaction
 * while another Stage holds it. #1550 — the redirect sync no longer pushes
 * staging (the staging gateway serves the staging view itself), so it takes
 * no part; the previous release's sync may still claim it during the roll
 * (`holder_sync_id`), which a Stage waits out like any holder. Publish live
 * does not touch staging (it copies the build live) and takes no part.
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
  type DeployLeaseHolder,
  previousReleaseRunInFlight,
  releaseLease,
  renewLease,
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
