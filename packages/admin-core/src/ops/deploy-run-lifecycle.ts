// SPDX-License-Identifier: MPL-2.0

/**
 * #1003 / #1211 / #1225 — the lifecycle of a deploy run, one short
 * transaction per step.
 *
 *   beginRunInTx                       commit the run's row as `running` with
 *                                      its lease (inside each run's start step)
 *   deploy.renew_run_lease             heartbeat of a run: its own lease and
 *                                      every publish lease it holds
 *   deploy.acquire_staging_publication take the staging-publication lease
 *   deploy.acquire_live_release        take the live-release lease
 *   deploy.fail_run                    finish a run as failed, release its leases
 *
 * Their `deploy_runs` row used to be inserted in the long transaction that
 * builds and publishes, so nobody saw a run while it ran. A Stage, a
 * Publish live and a plugin-data build now hold no transaction at all while
 * they build (#1211, #1225): their steps commit on their own, their
 * liveness is a lease on their row (deploy-run-lock.ts) and their place in
 * the publish order a lease row (staging-publication-lock.ts,
 * live-release-lock.ts).
 *
 * The start's sweep marks runs that died mid-build as failed — never one
 * still being built, on this instance or any other.
 */

import { defineOperation, type TransactionRunner } from "@caelo-cms/query-api";
import { ok, phaseTimingSchema } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { deployRunIsOrphaned } from "../deploy/deploy-run-lock.js";
import {
  acquireLiveRelease,
  releaseLiveRelease,
  renewLiveRelease,
} from "../deploy/live-release-lock.js";
import { deployPluginProblem } from "../deploy/plugin-problems.js";
import {
  acquireStagingPublication,
  releaseStagingPublication,
  renewStagingPublication,
} from "../deploy/staging-publication-lock.js";
import { jsonbParam } from "../sql-helpers.js";

/** What a run that died mid-build says, and what to do about it. */
export const ORPHANED_RUN_MESSAGE =
  "This build stopped without finishing (the admin restarted or crashed while it ran), so nothing it built was published. Start it again.";

const leaseTtl = z.number().int().min(1_000).max(3_600_000);

/** What a lease acquisition answers. */
const leaseAcquired = z.object({
  acquired: z.boolean(),
  /** The run holding it; null when acquired, or when a transaction (or the previous release) holds it. */
  heldByRunId: z.string().nullable(),
});

/** The row a run starts with (the start steps of deploy.trigger / .promote / the plugin-data build). */
export const beginRunInput = z
  .object({
    runId: z.string().uuid(),
    targetId: z.string().uuid(),
    /**
     * Who started the run (the trigger's actor, not the system actor this
     * op runs as). Not `.uuid()`: the system actor's id is not an RFC 4122
     * UUID; the `::uuid` cast checks the format.
     */
    actorId: z.string().min(1),
    /** The trigger's start on the DB clock, so the run's span covers its preparation. */
    startedAt: z.string().min(1),
    /** #553 — main's render fingerprint at the start of a staging build. */
    renderFingerprint: z.unknown().nullable(),
    /** #834 — the Caelo version rendering the build; null for a copy-promote. */
    caeloVersion: z.string().nullable(),
    /**
     * #1008 — the active plugins that did not run for this build (Publish
     * live refuses a Stage that has any); null for a dev build or a
     * Publish live run, which are not checked.
     */
    pluginProblems: z.array(deployPluginProblem).nullable(),
    /** #1155 — what kind of build the run is (default: a site build). */
    buildKind: z.enum(["site", "plugin_data"]).default("site"),
    /** #1155 — a plugin-data run's base: the live run its files came from. */
    baseRunId: z.string().uuid().nullable().default(null),
    /** #1211 — the run's lease; the run renews it (deploy.renew_run_lease). */
    leaseTtlMs: leaseTtl,
  })
  .strict()
  .refine((i) => (i.buildKind === "plugin_data") === (i.baseRunId !== null), {
    message: "a plugin_data run names its base run, and only it does",
  });

/**
 * Mark `runId` failed with {@link ORPHANED_RUN_MESSAGE} when it is still
 * `running` but nothing builds it any more ({@link deployRunIsOrphaned}),
 * and free the leases it held. The start of the next run sweeps every such
 * run; the reads that report a run's state call this for the runs they
 * return (#1307), so a Stage whose process died reads as failed with the
 * restart hint instead of as running until someone starts another one.
 *
 * @returns the run's new `finished_at` when this call marked it failed,
 *   else null.
 */
export async function failRunIfOrphanedInTx(
  tx: TransactionRunner,
  runId: string,
): Promise<string | Date | null> {
  if (!(await deployRunIsOrphaned(tx, runId))) return null;
  const marked = (await tx.execute(sql`
    UPDATE deploy_runs
    SET status = 'failed', finished_at = clock_timestamp(), error_message = ${ORPHANED_RUN_MESSAGE},
        -- #1319 — a run that never succeeded never writes its planned audit.
        lease_expires_at = NULL, planned_audit = NULL
    WHERE id = ${runId}::uuid AND status = 'running'
      -- A heartbeat that renewed the lease after the check above wins: the
      -- run is alive. A lease-less (legacy) run is held by the advisory
      -- lock the check took for the rest of this transaction.
      AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
    RETURNING finished_at
  `)) as unknown as { finished_at: string | Date }[];
  const finishedAt = marked[0]?.finished_at;
  if (finishedAt === undefined) return null;
  // A lease the dead run held has lapsed too; free it so the row says so.
  await releaseStagingPublication(tx, runId);
  await releaseLiveRelease(tx, runId);
  console.error("[deploy] marked a run that stopped mid-build as failed", { runId });
  return finishedAt;
}

/** The columns of a `deploy_runs` read that {@link settleOrphanedRuns} corrects. */
interface RunStateRow {
  readonly id: string;
  readonly status: "pending" | "running" | "succeeded" | "failed";
  readonly finished_at: string | Date | null;
  readonly error_message: string | null;
}

/**
 * #1307 — `rows` as they are once every `running` row among them whose
 * build died is marked failed ({@link failRunIfOrphanedInTx}): the
 * database row is corrected and the returned copy says what it now says.
 * For the reads that answer "where is this run?" — without it a dead Stage
 * read as running (with an estimate) until the next Stage swept it. With
 * `correctRows: false` the rows are only projected, nothing is written.
 */
export async function settleOrphanedRuns<R extends RunStateRow>(
  tx: TransactionRunner,
  rows: readonly R[],
  opts: { readonly correctRows: boolean } = { correctRows: true },
): Promise<R[]> {
  const out: R[] = [];
  for (const row of rows) {
    let finishedAt: string | Date | null = null;
    if (row.status === "running") {
      if (opts.correctRows) finishedAt = await failRunIfOrphanedInTx(tx, row.id);
      // A read that must not write (a plugin's) still answers what the row
      // will say once the next correcting read or run start sweeps it.
      else if (await deployRunIsOrphaned(tx, row.id)) finishedAt = new Date();
    }
    out.push(
      finishedAt === null
        ? row
        : // Every run status union has "failed"; R only narrows the other columns.
          ({
            ...row,
            status: "failed",
            finished_at: finishedAt,
            error_message: ORPHANED_RUN_MESSAGE,
          } as R),
    );
  }
  return out;
}

/**
 * Sweep runs that died mid-build, then insert `input`'s row as running.
 * Runs in the caller's (start step's) transaction.
 *
 * @returns the ids of the runs marked failed.
 */
export async function beginRunInTx(
  tx: TransactionRunner,
  input: z.infer<typeof beginRunInput>,
): Promise<string[]> {
  const running = (await tx.execute(sql`
    SELECT id::text AS id FROM deploy_runs WHERE status = 'running' AND id <> ${input.runId}::uuid
  `)) as unknown as { id: string }[];
  const orphanedRunIds: string[] = [];
  for (const { id } of running) {
    if ((await failRunIfOrphanedInTx(tx, id)) !== null) orphanedRunIds.push(id);
  }
  await tx.execute(sql`
    INSERT INTO deploy_runs (id, target_id, actor_id, status, started_at, render_fingerprint,
                             caelo_version, plugin_problems, build_kind, base_run_id,
                             lease_expires_at)
    VALUES (${input.runId}::uuid, ${input.targetId}::uuid, ${input.actorId}::uuid, 'running',
            ${input.startedAt}::timestamptz,
            ${input.renderFingerprint === null ? sql`NULL` : jsonbParam(input.renderFingerprint)},
            ${input.caeloVersion},
            ${input.pluginProblems === null ? sql`NULL` : jsonbParam(input.pluginProblems)},
            ${input.buildKind},
            ${input.baseRunId === null ? sql`NULL` : sql`${input.baseRunId}::uuid`},
            clock_timestamp() + ${input.leaseTtlMs}::int * interval '1 millisecond')
  `);
  return orphanedRunIds;
}

export const renewDeployRunLeaseOp = defineOperation({
  name: "deploy.renew_run_lease",
  readScope: "request",
  // Why human-only: the heartbeat of a running build (deploy.trigger,
  // deploy.promote and the plugin-data build run it under the system
  // actor); it decides nothing.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ runId: z.string().uuid(), ttlMs: leaseTtl }).strict(),
  output: z.object({
    /** False when the row is no longer running (it was swept as orphaned). */
    running: z.boolean(),
    publication: z.enum(["renewed", "lost", "not-held"]),
    liveRelease: z.enum(["renewed", "lost", "not-held"]),
  }),
  // No audit row: a heartbeat only moves an expiry forward.
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE deploy_runs
      SET lease_expires_at = clock_timestamp() + ${input.ttlMs}::int * interval '1 millisecond'
      WHERE id = ${input.runId}::uuid AND status = 'running' AND lease_expires_at IS NOT NULL
      RETURNING 1 AS renewed
    `)) as unknown as { renewed: number }[];
    return ok({
      running: rows.length > 0,
      publication: await renewStagingPublication(tx, input),
      liveRelease: await renewLiveRelease(tx, input),
    });
  },
});

export const acquireStagingPublicationOp = defineOperation({
  name: "deploy.acquire_staging_publication",
  readScope: "request",
  // Why human-only: internal step of deploy.trigger (system actor); a Stage
  // takes the lease before its upload fills a staging slot (#1330).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ runId: z.string().uuid(), ttlMs: leaseTtl }).strict(),
  output: leaseAcquired.extend({
    /**
     * #1330 — where the build staging serves lies in staging storage
     * (`staging_access.served_location`), read with the lease taken: nobody
     * else changes it until the lease is released. The Stage fills the
     * other slot. Null when not acquired or nothing was staged since #1330.
     */
    servedLocation: z.string().nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const r = await acquireStagingPublication(tx, input);
    if (!r.acquired) {
      return ok({ acquired: false, heldByRunId: r.heldBy?.runId ?? null, servedLocation: null });
    }
    const served = (await tx.execute(sql`
      SELECT served_location FROM staging_access WHERE id = 1
    `)) as unknown as { served_location: string | null }[];
    return ok({
      acquired: true,
      heldByRunId: null,
      servedLocation: served[0]?.served_location ?? null,
    });
  },
});

export const acquireLiveReleaseOp = defineOperation({
  name: "deploy.acquire_live_release",
  readScope: "request",
  // Why human-only: internal step of deploy.promote and the plugin-data
  // build (system actor); they take the lease before they release a new
  // version on the live channel.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ runId: z.string().uuid(), ttlMs: leaseTtl }).strict(),
  output: leaseAcquired,
  handler: async (_ctx, input, tx) => {
    const r = await acquireLiveRelease(tx, input);
    return ok(
      r.acquired
        ? { acquired: true, heldByRunId: null }
        : { acquired: false, heldByRunId: r.heldBy?.runId ?? null },
    );
  },
});

export const failDeployRunOp = defineOperation({
  name: "deploy.fail_run",
  readScope: "request",
  // Why human-only: internal step of every deploy run (system actor) — the
  // run's own failure record.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      runId: z.string().uuid(),
      message: z.string().min(1),
      /** The run's step timings so far (deploy_runs.phase_timings). */
      phaseTimings: z.array(phaseTimingSchema),
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE deploy_runs
      SET status = 'failed', finished_at = clock_timestamp(), error_message = ${input.message},
          phase_timings = ${jsonbParam(input.phaseTimings)}, lease_expires_at = NULL,
          -- #1319 — a failed build never writes its planned audit.
          planned_audit = NULL
      WHERE id = ${input.runId}::uuid AND status = 'running'
    `);
    await releaseStagingPublication(tx, input.runId);
    await releaseLiveRelease(tx, input.runId);
    return ok({});
  },
});
