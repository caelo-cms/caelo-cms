// SPDX-License-Identifier: MPL-2.0

/**
 * #969 — the staging-preview keep-alive. Shortly after start and then every
 * six hours it runs `deploy.refresh_staging_preview`, which extends the
 * served staging preview's lifetime on providers where it is finite
 * (Firebase Hosting: 30 days at most). Stage and Publish live extend it
 * too; this covers an idle stretch while the admin runs. A failure is
 * logged loudly (the op's message names the next step, e.g. Stage again)
 * and retried on the next tick.
 *
 * Started once per admin process from `apps/admin/src/hooks.server.ts`. It
 * lived in the redeploy orchestrator until the automatic redeploy was
 * removed (#1154); its cadence moves to the scheduler tick under epic
 * #1140.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";

const SYSTEM_CTX = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "staging-preview-keepalive",
};

/** Six-hourly against a 30-day lifetime leaves ample room for failed ticks. */
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Soon after start: on a scale-to-zero admin an instance may not live six hours. */
const FIRST_REFRESH_MS = 30_000;

/** Extend the served staging preview once; logs a failure. */
async function refreshStagingPreviewOnce(deps: {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
}): Promise<void> {
  try {
    const r = await execute(
      deps.registry,
      deps.adapter,
      SYSTEM_CTX,
      "deploy.refresh_staging_preview",
      {},
    );
    if (!r.ok) console.error("[staging-preview-keepalive] keep-alive failed", r.error);
  } catch (e) {
    console.error("[staging-preview-keepalive] keep-alive failed", e);
  }
}

/**
 * Start the keep-alive loop. Returns a stop handle (tests; the admin
 * process runs it for its lifetime).
 *
 * @param opts.intervalMs / opts.firstRefreshMs - override the cadence (tests).
 */
export function startStagingPreviewKeepAliveWorker(opts: {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  readonly intervalMs?: number;
  readonly firstRefreshMs?: number;
}): { stop(): void } {
  const first = setTimeout(() => {
    void refreshStagingPreviewOnce(opts);
  }, opts.firstRefreshMs ?? FIRST_REFRESH_MS);
  const handle = setInterval(() => {
    void refreshStagingPreviewOnce(opts);
  }, opts.intervalMs ?? REFRESH_INTERVAL_MS);
  return {
    stop(): void {
      clearTimeout(first);
      clearInterval(handle);
    },
  };
}
