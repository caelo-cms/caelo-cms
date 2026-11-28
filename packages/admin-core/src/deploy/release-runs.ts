// SPDX-License-Identifier: MPL-2.0

/**
 * Which builds a Publish live moves between: the newest staged build, the
 * site build live serves, and the staging build that live build was copied
 * from. The Publish live review (`deploy.publish_preview`) compares the two
 * builds; a chat's change list (`chat.list_pending_changes`) dates "staged,
 * not live yet" from them.
 *
 * The live SITE build: a plugin-data build (#1155, `build_kind =
 * 'plugin_data'`) re-renders the baked regions of the live build and is
 * recorded as a production run of its own, with its own id as its build id.
 * It changes no page structure, so it is never the build a Publish live is
 * compared with: the newest site build is (a promote, a rollback, or an
 * Owner's direct production build). Reading the newest run of any kind
 * made every review after a plugin-data build say live was "built
 * directly" and list nothing.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";

/** The deploy target names the Publish live review compares by default. */
export const DEFAULT_STAGING_TARGET = "staging";
/** See {@link DEFAULT_STAGING_TARGET}. */
export const DEFAULT_PRODUCTION_TARGET = "production";

/** A succeeded build as the release reads need it. */
export interface ReleaseRun {
  readonly id: string;
  readonly build_id: string | null;
  readonly started_at: string | Date;
  readonly finished_at: string | Date | null;
  readonly has_fingerprint: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The newest succeeded build of a staging target: what Publish live copies. */
export async function newestStagedBuild(
  tx: TransactionRunner,
  stagingTargetId: string,
): Promise<ReleaseRun | undefined> {
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, build_id, started_at, finished_at,
           render_fingerprint IS NOT NULL AS has_fingerprint
      FROM deploy_runs
     WHERE target_id = ${stagingTargetId}::uuid AND status = 'succeeded' AND build_id IS NOT NULL
     ORDER BY started_at DESC LIMIT 1
  `)) as unknown as ReleaseRun[];
  return rows[0];
}

/** The site build a production target serves (plugin-data builds skipped, see the file comment). */
export async function liveSiteBuild(
  tx: TransactionRunner,
  productionTargetId: string,
): Promise<ReleaseRun | undefined> {
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, build_id, started_at, finished_at,
           render_fingerprint IS NOT NULL AS has_fingerprint
      FROM deploy_runs
     WHERE target_id = ${productionTargetId}::uuid AND status = 'succeeded' AND build_id IS NOT NULL
       AND build_kind = 'site'
     ORDER BY started_at DESC LIMIT 1
  `)) as unknown as ReleaseRun[];
  return rows[0];
}

/**
 * The staging build `live` was copied from: deploy.promote stamps its id
 * into the production run's `build_id` (a rollback carries the restored
 * run's). Undefined for an Owner's direct production build.
 */
export async function liveSourceBuild(
  tx: TransactionRunner,
  live: ReleaseRun,
  stagingTargetId: string,
): Promise<ReleaseRun | undefined> {
  if (!live.build_id || !UUID_RE.test(live.build_id)) return undefined;
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, build_id, started_at, finished_at,
           render_fingerprint IS NOT NULL AS has_fingerprint
      FROM deploy_runs WHERE id = ${live.build_id}::uuid AND target_id = ${stagingTargetId}::uuid
  `)) as unknown as ReleaseRun[];
  return rows[0];
}

/**
 * Since when a Stage's merge is not live yet: what a Stage merged at or
 * after this moment (`site_snapshots.staged_at`) reaches visitors only
 * with the next Publish live. It is the start of the build that rendered
 * what live serves (the run its `build_id` names): the staging build a
 * Publish live copied, or an Owner's direct production build, which built
 * main as it was then; a merge after that start is not in it. A rollback
 * names the restored run's build, so it dates from that build too, not
 * from the rollback. Null when nothing is live on the default production
 * target yet: every staged change is still to be published.
 */
export async function notLiveSince(tx: TransactionRunner): Promise<string | null> {
  const targets = (await tx.execute(sql`
    SELECT id::text AS id FROM deploy_targets WHERE name = ${DEFAULT_PRODUCTION_TARGET}
  `)) as unknown as { id: string }[];
  const production = targets[0];
  const live = production ? await liveSiteBuild(tx, production.id) : undefined;
  if (!live) return null;
  const built =
    live.build_id && UUID_RE.test(live.build_id)
      ? (
          (await tx.execute(sql`
            SELECT started_at FROM deploy_runs WHERE id = ${live.build_id}::uuid
          `)) as unknown as { started_at: string | Date }[]
        )[0]
      : undefined;
  // A live run whose build id names no run recorded its output as its own.
  const at = (built ?? live).started_at;
  return at instanceof Date ? at.toISOString() : String(at);
}
