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
 * CLOUD_RUN_EXECUTION, only labels the timeline with the execution name.
 *
 * The database connection uses Cloud SQL IAM authentication as the job's
 * service account, a member of the `platform_updater` role (migration 0267).
 * The access token is the password and lives about an hour; the job's task
 * timeout is 60 minutes, so the pool's connections outlive no token they
 * need.
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

const METADATA = "http://metadata.google.internal/computeMetadata/v1";

/** One metadata-server value (text). */
export async function metadata(path: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn(`${METADATA}/${path}`, { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) throw new Error(`metadata server ${path}: HTTP ${res.status}`);
  return (await res.text()).trim();
}

const log: JobLog = (entry) => console.log(JSON.stringify(entry));

async function main(): Promise<void> {
  const projectId = await metadata("project/project-id");
  // `projects/<number>/regions/<region>`
  const region = (await metadata("instance/region")).split("/").pop() ?? "";
  const email = await metadata("instance/service-accounts/default/email");
  const token = (
    JSON.parse(await metadata("instance/service-accounts/default/token")) as {
      access_token?: string;
    }
  ).access_token;
  if (!projectId || !region || !email || !token) {
    throw new Error("the metadata server did not name the project, region and service account");
  }
  const execution = process.env.CLOUD_RUN_EXECUTION?.trim() || null;
  const host = await upgraderDatabaseHost({ projectId, region });
  const urls = cloudSqlIamDatabaseUrls(host, email, token);
  const adapter = new DatabaseAdapter({
    adminDatabaseUrl: urls.admin,
    publicDatabaseUrl: urls.public,
    expectedRoles: { admin: urls.user, public: [urls.user] },
  });
  try {
    const result = await runUpgraderJob(
      gcpUpgraderDeps({ projectId, region, execution }, createDbUpdateQueue(adapter), log),
    );
    process.exitCode = result.exitCode;
  } finally {
    await adapter.close();
  }
}

if (import.meta.main) {
  await main().catch((e: unknown) => {
    log({ severity: "ERROR", message: `upgrader: ${e instanceof Error ? e.message : String(e)}` });
    process.exitCode = 1;
  });
}
