// SPDX-License-Identifier: MPL-2.0

/**
 * #1211 — no build stays in the admin container on a provider that
 * uploads builds.
 *
 * On Cloud Run (gcp / aws / azure) builds are written to
 * `/tmp/caelo-builds/<env>`, and `/tmp` there is memory: keeping the last
 * five builds per env (the generator's self-hosted retention) cost a flat
 * 0.5–1 GiB of a 2 GiB instance (#1209). A publisher that uploads the build
 * (`servesCurrentDir: false`) holds what it serves in the provider, so the
 * local copy is deleted as soon as the run is done with it: after the
 * upload and the parity fingerprint, or after the run failed. Self-hosted
 * serves `current/` from disk and rolls back from `builds/`, so it keeps
 * its retention.
 */

import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { StaticPublisher } from "./static-publisher.js";

/**
 * Where the generator writes run `runId`'s build (static-generator
 * generate.ts: `<repoRoot>/<outDir>/builds/<runId>`). Known before the
 * generator runs, so a run that fails mid-build still finds what it wrote.
 */
export function buildDirOf(repoRoot: string, outDir: string, runId: string): string {
  return join(resolve(repoRoot, outDir), "builds", runId);
}

/**
 * The generator's `retainBuilds` for `publisher`: 0 (prune nothing, the
 * admin deletes each build itself) when it uploads, otherwise the
 * generator's default.
 */
export function retainedBuildsFor(publisher: StaticPublisher): number | undefined {
  return publisher.servesCurrentDir ? undefined : 0;
}

/**
 * Delete `buildDir` when `publisher` uploads builds; leave it otherwise.
 * A failure is logged, never thrown: the run's outcome does not depend on
 * a temp directory, and the container's `/tmp` dies with the instance.
 */
export async function removeUploadedBuild(
  publisher: StaticPublisher,
  buildDir: string,
): Promise<void> {
  if (publisher.servesCurrentDir) return;
  try {
    await rm(buildDir, { recursive: true, force: true });
  } catch (e) {
    console.error("[deploy] could not delete the uploaded build from the container", {
      buildDir,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
