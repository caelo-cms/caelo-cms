// SPDX-License-Identifier: MPL-2.0

/**
 * `caelo-ops upgrader` — the upgrader job's entry point (epic #696), run by
 * the `caelo-<env>-upgrader` Cloud Run job from the caelo-ops image as the
 * job's own service account (packages/provisioning/src/upgrader-setup.ts).
 *
 * It takes no input but the database: argv and the environment are ignored
 * on purpose (the admin may start the job but cannot override it, and even
 * an override must not be able to point the job at another registry,
 * signer or install). Where it runs comes from the metadata server; what it
 * installs from the signed release manifest. The one env var read,
 * CLOUD_RUN_EXECUTION, names the execution for the timeline and for the
 * state lock's lease (#815).
 *
 * The database connection uses Cloud SQL IAM authentication as the job's
 * service account, a member of the `platform_updater` role (migration 0267).
 * The access token is the password and lives about an hour, so the queue
 * reopens its pool with a fresh token before it expires (token-queue.ts):
 * the job must still be able to record its end after a long migration.
 */

import {
  gcpUpgraderDeps,
  type JobLog,
  runUpgraderJob,
  upgraderDatabaseHost,
} from "@caelo-cms/provisioning";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import { cloudSqlIamDatabaseUrls } from "@caelo-cms/shared";
import { createDbUpdateQueue } from "./db-queue.js";
import { type AccessToken, parseMetadataToken, tokenRefreshingQueue } from "./token-queue.js";

const METADATA = "http://metadata.google.internal/computeMetadata/v1";

/** One metadata-server value (text). */
export async function metadata(path: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn(`${METADATA}/${path}`, { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) throw new Error(`metadata server ${path}: HTTP ${res.status}`);
  return (await res.text()).trim();
}

/** The job's service-account access token, with its expiry. */
export async function accessToken(): Promise<AccessToken> {
  const text = await metadata("instance/service-accounts/default/token");
  return parseMetadataToken(text, Date.now());
}

/** One structured Cloud Logging line per entry (stdout). */
export const log: JobLog = (entry) => console.log(JSON.stringify(entry));

/** Where a job runs and as whom: the metadata server, plus this execution's name. */
export async function jobPlacement(): Promise<{
  readonly projectId: string;
  readonly region: string;
  readonly email: string;
  readonly execution: string | null;
}> {
  const projectId = await metadata("project/project-id");
  // `projects/<number>/regions/<region>`
  const region = (await metadata("instance/region")).split("/").pop() ?? "";
  const email = await metadata("instance/service-accounts/default/email");
  if (!projectId || !region || !email) {
    throw new Error("the metadata server did not name the project, region and service account");
  }
  return { projectId, region, email, execution: process.env.CLOUD_RUN_EXECUTION?.trim() || null };
}

async function main(): Promise<void> {
  const { projectId, region, email, execution } = await jobPlacement();
  const host = await upgraderDatabaseHost({ projectId, region });
  const db = tokenRefreshingQueue({
    fetchToken: accessToken,
    open: (token) => {
      const urls = cloudSqlIamDatabaseUrls(host, email, token);
      const adapter = new DatabaseAdapter({
        adminDatabaseUrl: urls.admin,
        publicDatabaseUrl: urls.public,
        expectedRoles: { admin: urls.user, public: [urls.user] },
      });
      return { queue: createDbUpdateQueue(adapter), close: () => adapter.close() };
    },
    now: Date.now,
    onCloseError: (e) =>
      log({
        severity: "WARNING",
        message: `could not close a database pool: ${e instanceof Error ? e.message : String(e)}`,
      }),
  });
  try {
    const result = await runUpgraderJob(
      gcpUpgraderDeps({ projectId, region, execution }, db.queue, log),
    );
    process.exitCode = result.exitCode;
  } finally {
    await db.close();
  }
}

if (import.meta.main) {
  await main().catch((e: unknown) => {
    log({ severity: "ERROR", message: `upgrader: ${e instanceof Error ? e.message : String(e)}` });
    process.exitCode = 1;
  });
}
