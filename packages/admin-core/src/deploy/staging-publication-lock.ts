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
 * So the publish-record-prune sequence runs under one transaction-scoped
 * advisory lock: a Stage takes it before it publishes, Publish live before
 * it reads the origin and prunes. A later Stage waits for the earlier one to commit
 * and then supersedes it, which is the order operators expect. Lock order
 * against live-release-lock.ts is fixed (live release first, then this),
 * and a Stage never takes the live-release lock, so the two cannot
 * deadlock.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

/** The advisory-lock key. Exported for the serialization regression tests. */
export const STAGING_PUBLICATION_LOCK_KEY = "caelo:staging-publication";

/** Wait for any in-flight Stage / Publish live, then hold them off until this transaction ends. */
export async function lockStagingPublication(tx: TransactionRunner): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${STAGING_PUBLICATION_LOCK_KEY}))`);
}
