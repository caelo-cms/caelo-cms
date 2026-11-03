// SPDX-License-Identifier: MPL-2.0

/**
 * #969 — the staging-preview keep-alive. Every six hours it runs
 * `deploy.refresh_staging_preview`, which extends the served staging
 * preview's lifetime on providers where it is finite (Firebase Hosting: 30
 * days at most). Stage and Publish live extend it too; this covers an idle
 * stretch. Six-hourly against a 30-day lifetime leaves ample room for failed
 * runs.
 *
 * Runs on the scheduler tick (#1140, scheduler/core-tasks.ts). A failure is
 * recorded on the task (the op's message names the next step, e.g. Stage
 * again) and retried on its next run.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import { SYSTEM_ACTOR_ID } from "./audit.js";

const SYSTEM_CTX = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system" as const,
  requestId: "staging-preview-keepalive",
};

/** Extend the served staging preview once. Throws with the op's message when it fails. */
export async function refreshStagingPreview(deps: {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
}): Promise<void> {
  const r = await execute(
    deps.registry,
    deps.adapter,
    SYSTEM_CTX,
    "deploy.refresh_staging_preview",
    {},
  );
  if (!r.ok) {
    throw new Error(`deploy.refresh_staging_preview failed: ${JSON.stringify(r.error)}`);
  }
}
