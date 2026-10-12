// SPDX-License-Identifier: MPL-2.0

/**
 * Orders every write to the live channel of the static site.
 *
 * `deploy.promote` / `deploy.rollback` release a new version on the live
 * channel. The Firebase custom-domain CDN purge (firebase-custom-domain.ts)
 * also creates a live release: it reads the version that is live and
 * releases it again. Without ordering, a publish that lands between the
 * purge's read and its release is silently undone — the purge re-releases
 * the version the publish just replaced, while deploy_runs says the new
 * build is live.
 *
 * The deploy side takes the lock exclusively and waits; the purge only
 * TRIES it and skips when a publish holds it. Skipping is safe: the
 * publish's own release purges the CDN, and the purge is stateless (it
 * retries on the next status read while the domain is still newer than
 * the latest release). Transaction-scoped, so the lock ends with the
 * publishing transaction and needs no unlock path.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { type SQL, sql } from "drizzle-orm";

/** The advisory-lock key. Exported for the serialization regression tests. */
export const LIVE_RELEASE_LOCK_KEY = "caelo:static-live-release";

const lockKey = (): SQL => sql`hashtext(${LIVE_RELEASE_LOCK_KEY})`;

/** Publish side: wait for an in-flight purge, then keep purges out until this transaction ends. */
export async function lockLiveReleases(tx: TransactionRunner): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey()})`);
}

/**
 * Purge side: true when this transaction now holds the lock; false while a
 * publish (or another purge) holds it — the caller then skips the purge.
 */
export async function tryLockLiveReleases(tx: TransactionRunner): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT pg_try_advisory_xact_lock(${lockKey()}) AS ok
  `)) as unknown as { ok: boolean }[];
  return rows[0]?.ok === true;
}
