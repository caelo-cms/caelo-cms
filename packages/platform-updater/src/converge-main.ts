// SPDX-License-Identifier: MPL-2.0

/**
 * `caelo-ops converge-job` — the converge job's entry point (#819), run by
 * the `caelo-<env>-converge` Cloud Run job from the caelo-ops image as the
 * install's `caelo-provisioner` service account
 * (packages/provisioning/src/converge-job-setup.ts).
 *
 * Like the upgrader (main.ts) it takes no input but the database: argv and
 * the environment are ignored on purpose. Nobody holds runWithOverrides on
 * the job, and it is started through ops/caelo-converge-job, which refuses
 * other arguments and scrubs the environment (#883 review), so even an
 * override could not point it at another registry, signer or install. The
 * one env var read, CLOUD_RUN_EXECUTION, names this run for the timeline,
 * the state lock's lease and the hand-over between the job's two stages;
 * it must name a run of the converge job or the job stops.
 *
 * The database connection uses Cloud SQL IAM authentication as the
 * provisioner, whose database login is a member of `platform_updater`
 * only (migration 0267); the token-refreshing pool (token-queue.ts) keeps
 * it usable through a long converge.
 */

import {
  convergeExecutionNameError,
  gcpConvergeDeps,
  runConvergeJob,
  upgraderDatabaseHost,
} from "@caelo-cms/provisioning";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import { cloudSqlIamDatabaseUrls } from "@caelo-cms/shared";
import { createDbConvergeQueue } from "./db-queue.js";
import { accessToken, jobPlacement, log } from "./main.js";
import { tokenRefreshingConvergeQueue } from "./token-queue.js";

async function main(): Promise<void> {
  const { projectId, region, email, execution } = await jobPlacement();
  const badExecution = convergeExecutionNameError(execution);
  if (badExecution) throw new Error(`refused to run: ${badExecution}`);
  const host = await upgraderDatabaseHost({ projectId, region });
  const db = tokenRefreshingConvergeQueue({
    fetchToken: accessToken,
    open: (token) => {
      const urls = cloudSqlIamDatabaseUrls(host, email, token);
      const adapter = new DatabaseAdapter({
        adminDatabaseUrl: urls.admin,
        publicDatabaseUrl: urls.public,
        expectedRoles: { admin: urls.user, public: [urls.user] },
      });
      return { queue: createDbConvergeQueue(adapter), close: () => adapter.close() };
    },
    now: Date.now,
    onCloseError: (e) =>
      log({
        severity: "WARNING",
        message: `could not close a database pool: ${e instanceof Error ? e.message : String(e)}`,
      }),
  });
  try {
    const result = await runConvergeJob(
      gcpConvergeDeps({ projectId, region, execution }, db.queue, log),
    );
    process.exitCode = result.exitCode;
  } finally {
    await db.close();
  }
}

if (import.meta.main) {
  await main().catch((e: unknown) => {
    log({
      severity: "ERROR",
      message: `converge-job: ${e instanceof Error ? e.message : String(e)}`,
    });
    process.exitCode = 1;
  });
}
