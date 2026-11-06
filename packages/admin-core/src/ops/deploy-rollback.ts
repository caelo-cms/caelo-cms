// SPDX-License-Identifier: MPL-2.0

/**
 * Rollback: put any prior succeeded build of a target live again. No
 * rebuild — the publisher re-releases the archived build (self-hosted:
 * re-syncs `current/`; Firebase: a new release of the old Hosting version;
 * GCS: copies the archived objects into the live bucket).
 *
 * #1250 — a deploy run that holds NO transaction while the provider works,
 * the same shape as Publish live (#1225, deploy-promote.ts). The provider
 * call used to run inside the rollback's one transaction, pinning a pooled
 * connection `idle in transaction` (with the live-release lease row locked)
 * for as long as the provider took. Now each step is one short op:
 *
 *   deploy.start_rollback   validate the target and the build to restore,
 *                           commit the run's row as `running` with its lease
 *   deploy.acquire_live_release  take the live-release lease as the run,
 *                           polling outside any transaction while a Publish
 *                           live, plugin-data build, redirect push or CDN
 *                           purge holds it
 *   publisher.rollback      the provider release — no transaction open,
 *                           right after a fence proved the leases are held
 *   deploy.finish_rollback  record the run succeeded, release the lease,
 *                           bring back the restored build's plugin data and
 *                           mark the redirects behind — one transaction
 *   deploy.fail_run         on every failure before the release
 *
 * After the record, `redirects.sync_provider` puts the redirects table as
 * saved now on the restored build (its own short steps, #1254).
 *
 * Atomicity: what the run records is what is known to have happened. A
 * failure up to the provider call records the run failed and nothing changed
 * live. Once the provider released, the run is recorded succeeded only while
 * it still holds the live-release lease — then no other release can have
 * come in between. If the lease lapsed meanwhile (the heartbeat missed three
 * beats), another release may be live, so the run is recorded failed with
 * "roll back again" instead of claiming its build is what visitors get. A
 * process that dies between the release and the record leaves the run to
 * the sweep — the same window Publish live has. The publisher's rollback
 * takes no `beforeRelease` fence like Publish live's release does; the fence
 * runs right before the call, which holds the lease for at least half a TTL
 * (60 s), longer than a Hosting release takes.
 */

import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pointLiveRelease } from "@caelo-cms/migrations/public-projection";
import {
  defineOperation,
  defineStepwiseOperation,
  execute,
  OperationAbortError,
  type OperationSteps,
  type QueryError,
} from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  err,
  NO_BUILD_HEADERS_NOTE,
  ok,
  type Result,
} from "@caelo-cms/shared";
import { readSeoSettings } from "@caelo-cms/static-generator";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { describeError } from "../ai/tools/_describe-error.js";
import {
  DEPLOY_RUN_HEARTBEAT_MS,
  DEPLOY_RUN_LEASE_TTL_MS,
  type DeployRunBeat,
  DeployRunHeartbeat,
} from "../deploy/deploy-run-lock.js";
import { systemContextOf } from "../deploy/generator-subprocess.js";
import { LIVE_RELEASE_WAIT_MS, releaseLiveRelease } from "../deploy/live-release-lock.js";
import { resolveOutputRoot } from "../deploy/output-root.js";
import { markRedirectsBehind } from "../deploy/redirect-sync.js";
import { loadStaticPublisher, type PublishSummary } from "../deploy/static-publisher.js";
import { forgetAllBakes } from "../plugin-data/stale-pages.js";
import { jsonbParam } from "../sql-helpers.js";
import { rowToTarget, runStartedAt, TARGET_COLUMNS, type TargetDbRow } from "./deploy-common.js";
import { acquireLeaseStep, fenceRunLeases } from "./deploy-lease-steps.js";
import { beginRunInTx } from "./deploy-run-lifecycle.js";

const rollbackInput = z
  .object({
    targetName: z.string(),
    runId: z.string().uuid(),
    repoRoot: z.string().optional(),
    /**
     * The id the rollback's run gets, minted by an approved card that
     * claims its proposal first (deploy.execute_proposal): a retry finds
     * the rollback by it instead of releasing the old build again.
     * Default: a fresh id.
     */
    newRunId: z.string().uuid().optional(),
  })
  .strict();
const rollbackOutput = z.object({
  buildId: z.string(),
  newRunId: z.string(),
  /** #1454 — set when the restored build carries no page headers. */
  securityHeadersNote: z.string().optional(),
});

const leaseTtl = z.number().int().min(1_000).max(3_600_000);

/** What deploy.start_rollback hands the provider step. */
const rollbackPlan = z.object({
  /** #1454 — false for a build from before the page headers existed. */
  restoredHasSecurityHeaders: z.boolean(),
  target: z.object({
    id: z.string(),
    name: z.string(),
    env: z.enum(["dev", "staging", "production"]),
    outDir: z.string(),
    baseUrl: z.string(),
    robotsDefault: z.enum(["index", "noindex"]),
    isDefault: z.boolean(),
    pageUrlStyle: z.enum(["directory", "no-extension"]),
  }),
  buildId: z.string(),
  /** The restored run's `publish_summary.location` (Firebase: its Hosting version). */
  sourceLocation: z.string().nullable(),
  siteBaseUrl: z.string(),
});
type RollbackPlan = z.infer<typeof rollbackPlan>;

const refuse = (message: string): never => {
  throw new OperationAbortError({ kind: "HandlerError", operation: "deploy.rollback", message });
};

export const startRollbackOp = defineOperation({
  name: "deploy.start_rollback",
  readScope: "request",
  // Why human-only: the start step of deploy.rollback (itself human +
  // system, CMS_REQUIREMENTS §6), run as the rollback's caller.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      targetName: z.string(),
      restoreRunId: z.string().uuid(),
      runId: z.string().uuid(),
      leaseTtlMs: leaseTtl,
    })
    .strict(),
  output: rollbackPlan,
  handler: async (ctx, input, tx) => {
    const startedAt = await runStartedAt(tx);
    const targetRows = (await tx.execute(sql`
      SELECT ${TARGET_COLUMNS} FROM deploy_targets WHERE name = ${input.targetName} LIMIT 1
    `)) as unknown as TargetDbRow[];
    const target = targetRows[0];
    if (!target) return refuse(`target not found: ${input.targetName}`);
    const priorRows = (await tx.execute(sql`
      SELECT r.build_id, r.publish_summary->>'location' AS location, r.caelo_version,
             source.security_headers IS NOT NULL AS has_security_headers
      FROM deploy_runs r
      LEFT JOIN deploy_runs source ON source.id = CASE
        WHEN r.build_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN r.build_id::uuid END
      WHERE r.id = ${input.restoreRunId}::uuid
        AND r.target_id = ${target.id}::uuid
        AND r.status = 'succeeded'
        AND r.build_id IS NOT NULL
      LIMIT 1
    `)) as unknown as {
      build_id: string;
      location: string | null;
      caelo_version: string | null;
      has_security_headers: boolean | null;
    }[];
    const prior = priorRows[0];
    if (!prior) return refuse("no matching succeeded build for that target");
    // #1155 — the run carries the Caelo version that rendered the restored
    // build: it is what is live once the rollback released it, and a
    // plugin-data build refreshes regions only while the running version
    // rendered the live build.
    await beginRunInTx(tx, {
      runId: input.runId,
      targetId: target.id,
      actorId: ctx.actorId,
      startedAt,
      renderFingerprint: null,
      caeloVersion: prior.caelo_version,
      pluginProblems: null,
      buildKind: "site",
      baseRunId: null,
      leaseTtlMs: input.leaseTtlMs,
    });
    const { siteBaseUrl } = await readSeoSettings(tx);
    return ok({
      target: rowToTarget(target),
      buildId: prior.build_id,
      sourceLocation: prior.location,
      restoredHasSecurityHeaders: prior.has_security_headers === true,
      siteBaseUrl,
    });
  },
});

export const finishRollbackOp = defineOperation({
  name: "deploy.finish_rollback",
  readScope: "request",
  // Why human-only: the record step of deploy.rollback (itself human +
  // system, CMS_REQUIREMENTS §6), run as the rollback's caller.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      runId: z.string().uuid(),
      restoreRunId: z.string().uuid(),
      targetId: z.string().uuid(),
      buildId: z.string(),
      publishSummary: z.record(z.string(), z.unknown()),
    })
    .strict(),
  output: z.discriminatedUnion("recorded", [
    z.object({ recorded: z.literal(true) }),
    /** The lease lapsed while the provider released: the run is recorded failed with `message`. */
    z.object({ recorded: z.literal(false), message: z.string() }),
  ]),
  handler: async (ctx, input, tx) => {
    // The run row first, then the lease: the same order as the heartbeat
    // (deploy.renew_run_lease), so the two cannot deadlock.
    const rows = (await tx.execute(sql`
      SELECT r.status, r.actor_id::text AS actor_id, r.target_id::text AS target_id, t.env
      FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
      WHERE r.id = ${input.runId}::uuid FOR UPDATE OF r
    `)) as unknown as { status: string; actor_id: string; target_id: string; env: string }[];
    const run = rows[0];
    if (!run) {
      return refuse(
        `rollback run ${input.runId} has no row any more; the old build is live but cannot be recorded. Roll back again.`,
      );
    }
    // Only the rollback that started this run records it (the step is an
    // op of its own and must authorise nothing more).
    if (run.actor_id !== ctx.actorId || run.target_id !== input.targetId) {
      return refuse(`run ${input.runId} is not a rollback of this caller to this target.`);
    }
    if (run.status === "succeeded") return refuse(`run ${input.runId} is already recorded.`);
    // Released before the run is recorded: this transaction keeps the lease
    // row locked until it commits, so nobody else releases in between.
    const held = await releaseLiveRelease(tx, input.runId);
    if (held !== true) {
      // Review on #1383 — the lease lapsed while the provider released (the
      // heartbeat missed three beats; a row the sweep ended lost it too), so
      // another Publish live, rollback or plugin-data build may have released
      // in between and be what visitors get. Recording this run succeeded
      // would make it the live build in every reader (servedRun, liveRunOf)
      // and move the plugin data and bakes back on a guess. It is recorded
      // failed instead, with what to do; the redirects are re-pushed to what
      // the target serves either way.
      const message = `the rollback released build ${input.buildId}, but lost its place in the live release order while it ran, so another release may have replaced it. Settings → Deployments may not match what visitors get; roll back (or Publish live) again to put a known build live.`;
      console.error("[deploy] rollback released after losing the live-release lease", {
        runId: input.runId,
        status: run.status,
      });
      await tx.execute(sql`
        UPDATE deploy_runs
        SET status = 'failed', finished_at = clock_timestamp(), error_message = ${message},
            lease_expires_at = NULL
        WHERE id = ${input.runId}::uuid
      `);
      await markRedirectsBehind(tx, [input.targetId]);
      return ok({ recorded: false as const, message });
    }
    const restored = (await tx.execute(sql`
      SELECT projection_run_id::text AS projection_run_id FROM deploy_runs
      WHERE id = ${input.restoreRunId}::uuid
    `)) as unknown as { projection_run_id: string | null }[];
    const projectionRunId =
      run.env === "production" ? (restored[0]?.projection_run_id ?? null) : null;
    // The summary names where the rolled-back release now lives (Firebase:
    // the Hosting version the rollback created). Recording it makes this
    // run itself a valid rollback source later — without it the Firebase
    // publisher refuses a run with no `publish_summary.location`.
    await tx.execute(sql`
      UPDATE deploy_runs
      SET status = 'succeeded', finished_at = clock_timestamp(), error_message = NULL,
          build_id = ${input.buildId}, publish_summary = ${jsonbParam(input.publishSummary)},
          projection_run_id = ${projectionRunId}::uuid, lease_expires_at = NULL
      WHERE id = ${input.runId}::uuid
    `);
    // #1329 — the plugin data the restored build was released with comes
    // back with it (the drain after this commit publishes it). A run from
    // before #1329 released no frozen state; live keeps the one it has.
    if (projectionRunId !== null) await pointLiveRelease(tx, projectionRunId);
    // #1157 — the rolled-back build carries the redirects of its own time;
    // the provider must serve the table as it is now. #1254 — marked here,
    // pushed by deploy.rollback after this transaction commits.
    await markRedirectsBehind(tx, [input.targetId]);
    // #1155 — the build put back may lack any bake made since it ran.
    if (run.env === "production") await forgetAllBakes(tx);
    return ok({ recorded: true as const });
  },
});

/** The body of deploy.rollback (see the module comment). */
async function runRollback(
  ctx: ExecutionContext,
  input: z.infer<typeof rollbackInput>,
  steps: OperationSteps,
): Promise<Result<z.infer<typeof rollbackOutput>, QueryError>> {
  const { registry, adapter } = steps;
  const runId = input.newRunId ?? randomUUID();
  const ttlMs = DEPLOY_RUN_LEASE_TTL_MS;
  const refused = (message: string): Result<never, QueryError> =>
    err({ kind: "HandlerError", operation: "deploy.rollback", message });
  if (steps.signal?.aborted) {
    return refused("the rollback was stopped before it started; nothing was rolled back.");
  }
  const started = await execute(registry, adapter, ctx, "deploy.start_rollback", {
    targetName: input.targetName,
    restoreRunId: input.runId,
    runId,
    leaseTtlMs: ttlMs,
  });
  if (!started.ok) return err(started.error);
  const plan = started.value as RollbackPlan;
  const sys = systemContextOf(ctx);
  const heartbeat = new DeployRunHeartbeat(async (): Promise<DeployRunBeat> => {
    const r = await execute(registry, adapter, sys, "deploy.renew_run_lease", { runId, ttlMs });
    if (!r.ok) throw new Error(describeError(r.error));
    return r.value as DeployRunBeat;
  }, DEPLOY_RUN_HEARTBEAT_MS);
  const stop = steps.signal ? AbortSignal.any([steps.signal, heartbeat.lost]) : heartbeat.lost;

  /** Record the failure (releasing the lease) and answer with `message`. */
  const fail = async (message: string): Promise<Result<never, QueryError>> => {
    const r = await execute(registry, adapter, sys, "deploy.fail_run", {
      runId,
      message,
      phaseTimings: [],
    });
    // Unrecorded, the run's lease lapses and the next run marks it failed.
    if (!r.ok)
      console.error("[deploy] could not record the failed rollback", { runId, error: r.error });
    return refused(message);
  };

  /** Set when the run released but lost its lease first (deploy.finish_rollback). */
  let lostMessage: string | null = null;
  try {
    // A CDN purge, Publish live, plugin-data build or redirect push must not
    // release another version mid-rollback; it waits outside any transaction.
    const live = await acquireLeaseStep(steps, sys, {
      op: "deploy.acquire_live_release",
      runId,
      ttlMs,
      stop,
      waitMs: LIVE_RELEASE_WAIT_MS,
      what: "live release slot",
      busyMessage: (heldBy) =>
        `${heldBy ? `a Publish live or plugin-data build (run ${heldBy})` : "a redirect push, a CDN purge or a release of the previous Caelo version (during the update)"} kept releasing the live site for ${Math.round(LIVE_RELEASE_WAIT_MS / 60_000)} minutes, so nothing was rolled back. Roll back again once it finished (Settings → Deployments shows it).`,
    });
    if (!live.ok) return await fail(live.message);
    heartbeat.expectLiveRelease(true);

    const outDir = resolve(resolveOutputRoot(input.repoRoot), plan.target.outDir);
    let summary: PublishSummary;
    try {
      // v0.2.78 — delegate to the per-provider StaticPublisher.
      const publisher = await loadStaticPublisher(process.env.CAELO_PROVIDER);
      // Proof, right before the release, that the run still holds its
      // place in the live release order.
      const proof = await fenceRunLeases(steps, sys, {
        runId,
        ttlMs,
        need: { publication: false, liveRelease: true },
        lostMessage: (renewError) =>
          `rollback ${runId} lost its place in the live release order${renewError ? ` (${renewError})` : ""}, so nothing was rolled back: another release may have changed what is live. Roll back again.`,
      });
      if (!proof.ok) return await fail(proof.message);
      summary = await publisher.rollback({
        targetBuildId: plan.buildId,
        sourceBuildDir: join(outDir, "builds", plan.buildId),
        target: plan.target,
        siteBaseUrl: plan.siteBaseUrl,
        sourceLocation: plan.sourceLocation,
      });
    } catch (e) {
      return await fail(`rollback failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const finished = await execute(registry, adapter, ctx, "deploy.finish_rollback", {
      runId,
      restoreRunId: input.runId,
      targetId: plan.target.id,
      buildId: plan.buildId,
      publishSummary: summary as unknown as Record<string, unknown>,
    });
    if (!finished.ok) {
      return await fail(
        `the old build is live, but recording the rollback failed: ${describeError(finished.error)}. Settings → Deployments may not show it as live; roll back again to record it.`,
      );
    }
    const record = finished.value as { recorded: true } | { recorded: false; message: string };
    if (!record.recorded) lostMessage = record.message;
  } catch (e) {
    // A throw past the steps above is a bug; the run still ends failed and
    // releases its lease instead of waiting for it to lapse.
    return await fail(
      `rollback failed: an unexpected error stopped it: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    await heartbeat.stop();
  }

  // The build is back (or, lease lost, some build is); now the redirects as
  // saved now, in a sync of their own. A failure is recorded and retried by
  // the redirect-sync worker (the target stays behind).
  const synced = await execute(registry, adapter, ctx, "redirects.sync_provider", {
    trigger: "rollback",
    targetIds: [plan.target.id],
    ...(input.repoRoot ? { repoRoot: input.repoRoot } : {}),
  });
  if (!synced.ok) {
    console.error("[deploy] redirects not synced after the rollback; retried automatically", {
      runId,
      error: describeError(synced.error),
    });
  }
  if (lostMessage !== null) return refused(lostMessage);
  return ok({
    buildId: plan.buildId,
    newRunId: runId,
    ...(plan.restoredHasSecurityHeaders ? {} : { securityHeadersNote: NO_BUILD_HEADERS_NOTE }),
  });
}

/**
 * Rollback: put a prior succeeded build of a target live again. Atomic, no
 * rebuild. The caller passes the deploy_runs.id whose `build_id` should
 * become live. A step-wise op (see the module comment): no transaction is
 * open while it waits for the live-release lease or while the provider
 * releases.
 */
export const rollbackDeployOp = defineStepwiseOperation({
  name: "deploy.rollback",
  readScope: "request",
  // Why human-only: Ops-level decision per CMS_REQUIREMENTS §6.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: rollbackInput,
  output: rollbackOutput,
  stepwise: runRollback,
});
