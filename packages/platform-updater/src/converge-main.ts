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
 * it usable through a long converge. It opens on the host the install
 * dials today and moves to the DNS name once stage 2 ran the database TLS
 * step (converge-db.ts, #1373), so a failure of that step reaches the
 * update timeline.
 */

import {
  convergeDatabaseHost,
  convergeDatabaseTarget,
  convergeExecutionNameError,
  gcpConvergeDeps,
  runConvergeJob,
} from "@caelo-cms/provisioning";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import { cloudSqlIamDatabaseUrls, cloudSqlIamIpDatabaseUrls } from "@caelo-cms/shared";
import { convergeDatabase, ipTargetTls } from "./converge-db.js";
import { createDbConvergeQueue } from "./db-queue.js";
import { accessToken, jobPlacement, log } from "./main.js";

async function main(): Promise<void> {
  const { projectId, region, email, execution } = await jobPlacement();
  const badExecution = convergeExecutionNameError(execution);
  if (badExecution) throw new Error(`refused to run: ${badExecution}`);
  const placement = { projectId, region };
  const db = await convergeDatabase({
    resolveTarget: () => convergeDatabaseTarget(placement),
    // #1338 — run by the job as a step of stage 2 (converge-job.ts).
    runTlsStep: () => convergeDatabaseHost(placement),
    open: (target, token) => {
      const urls =
        target.kind === "dns"
          ? cloudSqlIamDatabaseUrls(target.host, email, token)
          : cloudSqlIamIpDatabaseUrls(target.host, email, token);
      const adapter = new DatabaseAdapter({
        adminDatabaseUrl: urls.admin,
        publicDatabaseUrl: urls.public,
        expectedRoles: { admin: urls.user, public: [urls.user] },
        ...(target.kind === "ip" ? { tls: ipTargetTls(target) } : {}),
      });
      return { queue: createDbConvergeQueue(adapter), close: () => adapter.close() };
    },
    fetchToken: accessToken,
    now: Date.now,
    warn: (message) => log({ severity: "WARNING", message }),
  });
  try {
    const result = await runConvergeJob(
      gcpConvergeDeps({ projectId, region, execution }, db.queue, db.secureDatabase, log),
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
