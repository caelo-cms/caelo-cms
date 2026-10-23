// SPDX-License-Identifier: MPL-2.0

/**
 * Tells a deploy run that is still building from one that died (#1003).
 *
 * A Stage or Publish live commits its `deploy_runs` row as `running` when
 * it starts — so the deployments page shows it and its progress — and
 * finishes it in the long transaction that builds and publishes. If that
 * process dies (crash, Cloud Run instance replaced, unexpected throw that
 * rolls the transaction back), nothing would ever finish the row.
 *
 * So the building transaction holds a transaction-scoped advisory lock on
 * its run id from before the row exists until it ends. Postgres releases
 * it with the transaction however that ends, on whichever instance it ran:
 * a `running` row whose lock can be taken has no transaction behind it
 * any more and is safe to mark failed.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

/** Prefix of the per-run advisory-lock key. Exported for the regression tests. */
export const DEPLOY_RUN_LOCK_PREFIX = "caelo:deploy-run:";

/** Hold `runId` as being built until this transaction ends. Take it BEFORE the row is committed. */
export async function holdDeployRun(tx: TransactionRunner, runId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${DEPLOY_RUN_LOCK_PREFIX} || ${runId}::text))`,
  );
}

/**
 * True when no transaction builds `runId` any more. Takes the lock for the
 * rest of THIS transaction, so the run cannot be resumed while it is
 * being marked failed.
 */
export async function deployRunIsOrphaned(tx: TransactionRunner, runId: string): Promise<boolean> {
  const rows = (await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtext(${DEPLOY_RUN_LOCK_PREFIX} || ${runId}::text)) AS free`,
  )) as unknown as { free: boolean }[];
  return rows[0]?.free === true;
}
