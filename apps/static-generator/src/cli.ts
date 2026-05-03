#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * P6.2 #5 — runnable Bun CLI entry point. The deploy ops in
 * @caelo/admin-core spawn this binary as a subprocess instead of
 * importing `generateSite` in-process. Two reasons:
 *
 *  - **Process isolation.** A generator OOM / panic doesn't take down
 *    the admin server. Exit code drives the deploy_runs row state.
 *  - **§3.1 alignment.** AI cannot reach the generator binary —
 *    moving the entry point out of the in-process import graph makes
 *    that constraint structural, not just a registry omission.
 *
 * Inputs: a JSON config blob on stdin
 *   {
 *     adminDatabaseUrl, publicDatabaseUrl,
 *     target: { id, name, env, outDir, baseUrl, robotsDefault },
 *     runId, repoRoot
 *   }
 *
 * Outputs (stdout, one JSON object per line):
 *   {kind:"progress", pagesDone, pagesTotal}
 *   final {kind:"done", pageCount, fileCount, durationMs, buildDir}
 *   on failure {kind:"error", message}
 *
 * Exit: 0 on done, 1 on error.
 */

import { DatabaseAdapter } from "@caelo/query-api";
import { type DeployTarget, generateSite } from "./generate.js";

interface CliInput {
  adminDatabaseUrl: string;
  publicDatabaseUrl: string;
  target: DeployTarget;
  runId: string;
  repoRoot: string;
  /** P13 ideas-pass — incremental rebuild whitelist (page ids).
   *  Empty/missing = full-site rebuild. */
  changedPageIds?: string[];
}

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";

function emit(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function main(): Promise<void> {
  const stdin = await Bun.stdin.text();
  const input = JSON.parse(stdin) as CliInput;

  const adapter = new DatabaseAdapter({
    adminDatabaseUrl: input.adminDatabaseUrl,
    publicDatabaseUrl: input.publicDatabaseUrl,
  });
  try {
    const result = await adapter.withAdminTransaction(
      { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: `gen-${input.runId}` },
      (tx) =>
        generateSite({
          tx,
          target: input.target,
          runId: input.runId,
          repoRoot: input.repoRoot,
          changedPageIds: input.changedPageIds,
          onProgress: (p) => emit({ kind: "progress", ...p }),
        }),
    );
    emit({ kind: "done", ...result });
  } finally {
    await adapter.close();
  }
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  emit({ kind: "error", message });
  process.exit(1);
});
