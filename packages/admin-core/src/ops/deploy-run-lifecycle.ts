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
    if (!(await deployRunIsOrphaned(tx, id))) continue;
    await tx.execute(sql`
      UPDATE deploy_runs
      SET status = 'failed', finished_at = clock_timestamp(), error_message = ${ORPHANED_RUN_MESSAGE},
          lease_expires_at = NULL
      WHERE id = ${id}::uuid AND status = 'running'
    `);
    // A lease the dead run held has lapsed too; free it so the row says so.
    await releaseStagingPublication(tx, id);
    await releaseLiveRelease(tx, id);
    orphanedRunIds.push(id);
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
  if (orphanedRunIds.length > 0) {
    console.error("[deploy] marked runs that stopped mid-build as failed", { orphanedRunIds });
  }
  return orphanedRunIds;
}

export const renewDeployRunLeaseOp = defineOperation({
  name: "deploy.renew_run_lease",
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
  // Why human-only: internal step of deploy.trigger / deploy.promote
  // (system actor); a Stage takes the lease before it publishes its
  // preview, a Publish live before it changes which preview staging serves.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ runId: z.string().uuid(), ttlMs: leaseTtl }).strict(),
  output: leaseAcquired.extend({
    /**
     * The run staging serves (`staging_access.origin_run_id`), read with
     * the lease taken: nobody else changes it until the lease is released.
     * Null when not acquired or nothing was ever staged.
     */
    servedRunId: z.string().nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const r = await acquireStagingPublication(tx, input);
    if (!r.acquired) {
      return ok({ acquired: false, heldByRunId: r.heldBy?.runId ?? null, servedRunId: null });
    }
    const served = (await tx.execute(sql`
      SELECT origin_run_id::text AS run_id FROM staging_access WHERE id = 1
    `)) as unknown as { run_id: string | null }[];
    return ok({ acquired: true, heldByRunId: null, servedRunId: served[0]?.run_id ?? null });
  },
});

export const acquireLiveReleaseOp = defineOperation({
  name: "deploy.acquire_live_release",
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
          phase_timings = ${jsonbParam(input.phaseTimings)}, lease_expires_at = NULL
      WHERE id = ${input.runId}::uuid AND status = 'running'
    `);
    await releaseStagingPublication(tx, input.runId);
    await releaseLiveRelease(tx, input.runId);
    return ok({});
  },
});
