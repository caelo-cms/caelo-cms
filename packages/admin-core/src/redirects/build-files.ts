// SPDX-License-Identifier: MPL-2.0

/**
 * #1550 — the builds a redirect decision is checked against
 * (`planRedirectRelease`, @caelo-cms/shared): which Staged change waits for
 * its target is decided against the files of the build it would go live
 * with, never guessed from the page rows.
 *
 * - The STAGED build (what Publish live ships, what the staging gateway
 *   serves): read from its staged manifest through the provider's publisher.
 *   A staged run's files never change, so they are kept per run (the two
 *   newest), exactly: no expiry, a new run is a new entry.
 * - The LIVE build (what Go live now and an Owner's production build check
 *   against): what the production target serves right now, read each time.
 *
 * Provider I/O: call these with no transaction open.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import type { RedirectPageUrlStyle } from "@caelo-cms/shared";
import type { DeployTarget } from "@caelo-cms/static-generator";
import { sql } from "drizzle-orm";
import { loadStaticPublisher, type StaticPublisher } from "../deploy/static-publisher.js";
import { rowToTarget, TARGET_COLUMNS, type TargetDbRow } from "../ops/deploy-common.js";

/** The staged build a Publish live from `fromTarget` would ship. */
export interface StagedBuild {
  readonly runId: string;
  /** Where its complete files lie in staging storage (`_slots/a`, `builds/<runId>`). */
  readonly location: string;
  readonly target: DeployTarget;
  readonly pageUrlStyle: RedirectPageUrlStyle;
}

/** A target's row as a {@link DeployTarget}. */
function deployTargetOf(row: TargetDbRow): DeployTarget {
  const t = rowToTarget(row);
  return {
    id: t.id,
    name: t.name,
    env: t.env,
    outDir: t.outDir,
    baseUrl: t.baseUrl,
    robotsDefault: t.robotsDefault,
    pageUrlStyle: t.pageUrlStyle,
  };
}

/**
 * The newest succeeded build of `fromTarget` (the one Publish live copies,
 * `deploy.start_promote`), or null when nothing was staged yet or the run
 * recorded no staging location (staged by an older release: Stage again).
 */
export async function loadStagedBuild(
  tx: TransactionRunner,
  fromTarget = "staging",
): Promise<StagedBuild | null> {
  const rows = (await tx.execute(sql`
    SELECT r.id::text AS run_id, r.publish_summary->>'stagingLocation' AS location,
           t.id::text AS t_id
    FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
    WHERE t.name = ${fromTarget} AND r.status = 'succeeded' AND r.build_id IS NOT NULL
    ORDER BY r.started_at DESC LIMIT 1
  `)) as unknown as { run_id: string; location: string | null; t_id: string }[];
  const run = rows[0];
  if (!run?.location) return null;
  const targets = (await tx.execute(sql`
    SELECT ${TARGET_COLUMNS} FROM deploy_targets WHERE id = ${run.t_id}::uuid
  `)) as unknown as TargetDbRow[];
  const target = targets[0];
  if (!target) return null;
  const t = deployTargetOf(target);
  return {
    runId: run.run_id,
    location: run.location,
    target: t,
    pageUrlStyle: t.pageUrlStyle ?? "directory",
  };
}

/** The production targets, as {@link DeployTarget}s. */
export async function loadProductionTargets(tx: TransactionRunner): Promise<DeployTarget[]> {
  const rows = (await tx.execute(sql`
    SELECT ${TARGET_COLUMNS} FROM deploy_targets WHERE env = 'production' ORDER BY name
  `)) as unknown as TargetDbRow[];
  return rows.map(deployTargetOf);
}

/**
 * The file lists of the last staged builds read, by run id. A staged
 * build's manifest never changes once its run succeeded, so an entry is
 * never stale: a release plan read on every Settings → Redirects load and
 * the Publish live that follows read the manifest once.
 */
const stagedFiles = new Map<string, ReadonlySet<string>>();
const STAGED_CACHE_SIZE = 2;

/** The files of `build` (its staged manifest). Throws with "Stage again" when it cannot be read. */
export async function stagedBuildFiles(
  build: StagedBuild,
  outputRoot: string,
  publisher?: StaticPublisher,
): Promise<ReadonlySet<string>> {
  const kept = stagedFiles.get(build.runId);
  if (kept) return kept;
  const pub = publisher ?? (await loadStaticPublisher(process.env.CAELO_PROVIDER));
  const files = await pub.readStagedBuildFiles({
    target: build.target,
    runId: build.runId,
    location: build.location,
    outputRoot,
  });
  stagedFiles.set(build.runId, files);
  while (stagedFiles.size > STAGED_CACHE_SIZE) {
    const oldest = stagedFiles.keys().next().value;
    if (oldest === undefined) break;
    stagedFiles.delete(oldest);
  }
  return files;
}

/** The files `target` serves now, or null when nothing is live there. */
export async function liveBuildFiles(
  target: DeployTarget,
  outputRoot: string,
  publisher?: StaticPublisher,
): Promise<ReadonlySet<string> | null> {
  const pub = publisher ?? (await loadStaticPublisher(process.env.CAELO_PROVIDER));
  return pub.readServedFiles({ target, outputRoot });
}
