// SPDX-License-Identifier: MPL-2.0

/**
 * `deploy.promote` — Publish live (P6.2): ship the source target's
 * currently-active build to the destination through the provider's
 * StaticPublisher. Promote intentionally ships staging's exact build to
 * production so what staging shows is what production gets: page HTML
 * and sitemap.xml are copied verbatim, which is safe because the
 * generator renders them env-independently (no env-level `noindex`
 * meta; the sitemap is written for every env — seo-pass.ts).
 *
 * Only the per-target artefacts are rewritten for the destination:
 * robots.txt (the destination's policy, with the `Sitemap:` line built
 * from site_defaults.site_base_url), routing-manifest.json, and — on
 * publishers that attach response headers to a release (Firebase) —
 * the env-level `X-Robots-Tag` header. A source build from before the
 * env-independent SEO pass is refused with a "Stage again" next step.
 *
 * #650 — a build staged with its own staging host (deploy_runs.site_url
 * set) is not copied: Publish live rebuilds main with the live host and
 * ships the rebuild only when it matches the staged build file by file
 * with the host swapped back (build-parity.ts). Anything else that
 * differs blocks the publish and names the files.
 *
 * #1225 — Publish live holds NO database transaction while it rebuilds and
 * uploads. It is a step-wise op (`defineStepwiseOperation`), like the Stage
 * (deploy-trigger.ts); every database step is a short op of its own:
 *
 *   deploy.start_promote     the gates (targets, a human for production,
 *                            plugins, the quality gate or a publish-anyway
 *                            decision), the run row committed as `running`
 *                            with its lease
 *   deploy.acquire_live_release        the live-release lease (waits outside
 *                            any transaction for a rollback or plugin-data
 *                            build that is releasing right now)
 *   deploy.acquire_staging_publication (a build with its own staging host)
 *   (select the served staging preview, rebuild + parity, or copy)
 *                            no transaction; progress via deploy.update_progress
 *   deploy.renew_run_lease   the fence: proof the run still holds every lease,
 *                            right before the provider release
 *   (provider release)       no transaction
 *   deploy.finish_promote    record the run (first publication, bakes, the
 *                            publish-anyway decision), release the leases,
 *                            mark the target's redirects behind
 *   redirects.sync_provider  push the redirects (after the run is recorded)
 *   deploy.fail_run          on every failure or abort before the release
 *
 * A heartbeat (deploy.renew_run_lease) keeps the run's lease and the
 * publish leases alive. The caller's abort (and a lost lease) is honoured
 * up to the fence; once the provider released the new version the run is
 * recorded, because production serves it.
 *
 * Before #1225 one transaction held a pooled connection for the whole
 * rebuild and upload while its own progress writes took more from the same
 * pool (#1209); an approved card and "publish anyway" ran it inside their
 * own transactions on top of that.
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  defineOperation,
  defineStepwiseOperation,
  execute,
  OperationAbortError,
  type OperationSteps,
  type QueryError,
} from "@caelo-cms/query-api";
import {
  CAELO_VERSION,
  type ExecutionContext,
  err,
  ok,
  PhaseTimer,
  phaseTimingSchema,
  type Result,
} from "@caelo-cms/shared";
import { type DeployTarget, readSeoSettings } from "@caelo-cms/static-generator";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { describeError } from "../ai/tools/_describe-error.js";
import { buildDirOf, removeUploadedBuild, retainedBuildsFor } from "../deploy/build-cleanup.js";
import { buildManifestOf, compareBuildManifests, parityRefusal } from "../deploy/build-parity.js";
import {
  DEPLOY_RUN_HEARTBEAT_MS,
  DEPLOY_RUN_LEASE_TTL_MS,
  type DeployRunBeat,
  DeployRunHeartbeat,
} from "../deploy/deploy-run-lock.js";
import {
  abortMessage,
  resolveGeneratorCli,
  runGenerator,
  systemContextOf,
} from "../deploy/generator-subprocess.js";
import { LIVE_RELEASE_WAIT_MS, releaseLiveRelease } from "../deploy/live-release-lock.js";
import { resolveOutputRoot } from "../deploy/output-root.js";
import {
  activePluginProblems,
  describePluginProblems,
  stagedWithoutPlugins,
} from "../deploy/plugin-problems.js";
import { markRedirectsBehind } from "../deploy/redirect-sync.js";
import {
  releaseStagingPublication,
  STAGING_PUBLICATION_WAIT_MS,
} from "../deploy/staging-publication-lock.js";
import { loadStaticPublisher, type StaticPublisher } from "../deploy/static-publisher.js";
import { rewindBakesToRun } from "../plugin-data/stale-pages.js";
import { jsonbParam } from "../sql-helpers.js";
import { deployRunStartedAt, stampFirstPublished } from "./content/first-published.js";
import {
  effectiveOutDir,
  logRunTimings,
  productionNeedsHuman,
  rowToTarget,
  runStartedAt,
  selectServedStagingPreview,
  TARGET_COLUMNS,
  type TargetDbRow,
  targetRow,
} from "./deploy-common.js";
import { acquireLeaseStep, fenceRunLeases } from "./deploy-lease-steps.js";
import { beginRunInTx } from "./deploy-run-lifecycle.js";
import { actorHasPermission } from "./quality/_permissions.js";
import { json } from "./quality/_shared.js";
import { publishGateForRun } from "./quality/gate-loader.js";
import { recordProductionOverride } from "./quality/production-gate.js";

/** A human's decision to publish over the staged build's FAILED quality check (#553). */
const publishAnywaySchema = z
  .object({
    /** Exactly the failed audit of the staged build being published. */
    auditRunId: z.string().uuid(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

const promoteInput = z.object({
  fromTarget: z.string(),
  toTarget: z.string(),
  repoRoot: z.string().optional(),
  /**
   * The id the run gets, minted by an approved card that claims its
   * proposal before the run exists (deploy.execute_proposal). Default: a
   * fresh id.
   */
  runId: z.string().uuid().optional(),
  /**
   * #553 — publish although the staged build's quality check FAILED (no
   * result): `quality_audits.publish_anyway` passes the human's decision.
   * Honoured only for a human holding deploy.trigger and only for exactly
   * the failed audit of the build being published; recorded on the audit
   * run in the same transaction that records the run as succeeded, so a
   * failed Publish live leaves the gate closed and the trail clean.
   */
  publishAnyway: publishAnywaySchema.optional(),
});

const promoteOutput = z.object({
  fromRunId: z.string(),
  toRunId: z.string(),
  buildId: z.string(),
});

/** What deploy.start_promote hands the rest of the run. */
const promotePlan = z.object({
  toRunId: z.string(),
  from: targetRow,
  to: targetRow,
  /** The staged run being published and its build. */
  fromRunId: z.string(),
  buildId: z.string(),
  /** #650 — the staging host the staged build carries, or null (copied as is). */
  stagedSiteUrl: z.string().nullable(),
  /** The staged run's first-publication instant (the rebuild renders it too). */
  publishAt: z.string(),
  /** The staged build's host-normalised manifest (#650), null when it has none. */
  parityManifest: z.record(z.string(), z.string()).nullable(),
  /** The Caelo version that rendered the staged build (#834), null before 0287. */
  stagedCaeloVersion: z.string().nullable(),
  stagedPageCount: z.number().int().nullable(),
  stagedFileCount: z.number().int().nullable(),
  /** The live host (site_defaults.site_base_url). */
  siteBaseUrl: z.string(),
  override: z.object({ auditRunId: z.string(), reason: z.string() }).nullable(),
});
type PromotePlan = z.infer<typeof promotePlan>;

function refused(message: string): Result<never, QueryError> {
  return err({ kind: "HandlerError", operation: "deploy.promote", message });
}

export const startPromoteOp = defineOperation({
  name: "deploy.start_promote",
  // Why human-only: the first step of deploy.promote (itself human +
  // system), run under the promote's own context: its gates decide on the
  // caller (production needs a human; publish anyway needs a human holding
  // deploy.trigger). No AI tool wraps it.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: promoteInput.omit({ runId: true, repoRoot: true }).extend({
    runId: z.string().uuid(),
    leaseTtlMs: z.number().int().min(1_000).max(3_600_000),
  }),
  output: promotePlan,
  handler: async (ctx, input, tx) => {
    const startedAt = await runStartedAt(tx);
    if (input.fromTarget === input.toTarget) return refused("fromTarget and toTarget must differ");
    const rows = (await tx.execute(sql`
      SELECT ${TARGET_COLUMNS} FROM deploy_targets
      WHERE name IN (${input.fromTarget}, ${input.toTarget})
    `)) as unknown as TargetDbRow[];
    const from = rows.find((r) => r.name === input.fromTarget);
    const to = rows.find((r) => r.name === input.toTarget);
    if (!from || !to) return refused("fromTarget or toTarget not found");
    const fromRunRows = (await tx.execute(sql`
      SELECT id::text AS id, build_id, site_url, plugin_problems, parity_manifest,
             caelo_version, page_count, file_count
      FROM deploy_runs
      WHERE target_id = ${from.id}::uuid AND status = 'succeeded' AND build_id IS NOT NULL
      ORDER BY started_at DESC LIMIT 1
    `)) as unknown as {
      id: string;
      build_id: string | null;
      site_url: string | null;
      plugin_problems: unknown;
      parity_manifest: Record<string, string> | string | null;
      caelo_version: string | null;
      page_count: number | string | null;
      file_count: number | string | null;
    }[];
    const fromRow = fromRunRows[0];
    if (!fromRow?.build_id) {
      // run #10 D6 — AI/operator-actionable failure surface (CLAUDE.md
      // §11): name the next step instead of just the diagnosis.
      return refused(
        `no succeeded build to promote from '${from.name}' — run Stage first (deploy.trigger targetName=${from.name}); Publish live only copies an already-staged build`,
      );
    }
    // #1154 — Publish live is a human's click (the toolbar, the pages list,
    // Ops, or an approved propose_deploy_promote applied as the approver).
    const automatic = productionNeedsHuman(ctx, to.env, "deploy.promote");
    if (automatic) return err(automatic);

    // #1008 — never publish a site without an active plugin: not while one
    // is not running, and not a Stage that was built while one was not
    // (it lacks that plugin's output even after the plugin recovered).
    if (to.env === "production") {
      const stale = stagedWithoutPlugins(fromRow.plugin_problems);
      if (stale) return refused(stale);
      const problems = await activePluginProblems(tx);
      if (problems.length > 0) return refused(describePluginProblems(problems));
    }

    // #553 — the quality gate. Every Publish-live path runs this step (the
    // toolbar, the pages list, Ops, the approved propose_deploy_promote and
    // publish anyway), so the gate lives here and nowhere else. Only staging
    // builds are audited, so only they are gated.
    let override: PromotePlan["override"] = null;
    if (from.env === "staging") {
      const gate = await publishGateForRun(tx, fromRow.id);
      if (!gate.open) {
        const decision = input.publishAnyway;
        if (!decision) return refused(gate.message);
        if (gate.state !== "errored" || gate.auditRunId !== decision.auditRunId) {
          return refused(
            gate.state === "errored"
              ? `audit ${decision.auditRunId} is not the failed check of the staged build being published (that is ${gate.auditRunId}) — call quality_audits.gate_status for the current one`
              : `publish anyway only applies to a FAILED quality check; the staged build's check is '${gate.state}'. ${gate.message}`,
          );
        }
        if (ctx.actorKind !== "human" || !(await actorHasPermission(tx, ctx, "deploy.trigger"))) {
          return refused(
            "publishing over a failed quality check is a human decision that needs the deploy.trigger permission — ask an editor who may publish to decide",
          );
        }
        override = { auditRunId: decision.auditRunId, reason: decision.reason };
      }
    }

    // The run row commits with this transaction, as `running` with its
    // lease: the deployments page shows it and its rebuild's progress.
    await beginRunInTx(tx, {
      runId: input.runId,
      targetId: to.id,
      actorId: ctx.actorId,
      startedAt,
      renderFingerprint: null,
      // Set when the run finishes: a rebuild is rendered by this version,
      // a copy keeps the version of the build it copies.
      caeloVersion: null,
      // The plugin check belongs to the Stage it promotes, not to this run.
      pluginProblems: null,
      buildKind: "site",
      baseRunId: null,
      leaseTtlMs: input.leaseTtlMs,
    });
    const num = (v: number | string | null): number | null =>
      v === null ? null : typeof v === "string" ? Number.parseInt(v, 10) : v;
    return ok({
      toRunId: input.runId,
      from: rowToTarget(from),
      to: rowToTarget(to),
      fromRunId: fromRow.id,
      buildId: fromRow.build_id,
      stagedSiteUrl: fromRow.site_url,
      // The staged build's instant: the parity guard compares the two
      // renders, and Publish live stores this value (#1121 review).
      publishAt: await deployRunStartedAt(tx, fromRow.id),
      parityManifest:
        fromRow.parity_manifest === null
          ? null
          : json<Record<string, string>>(fromRow.parity_manifest),
      stagedCaeloVersion: fromRow.caelo_version,
      stagedPageCount: num(fromRow.page_count),
      stagedFileCount: num(fromRow.file_count),
      siteBaseUrl: (await readSeoSettings(tx)).siteBaseUrl,
      override,
    });
  },
});

export const finishPromoteOp = defineOperation({
  name: "deploy.finish_promote",
  // Why human-only: the last step of deploy.promote (itself human +
  // system), run under the promote's own context (the publish-anyway
  // decision is recorded as the human who made it). No AI tool wraps it.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      runId: z.string().uuid(),
      fromRunId: z.string().uuid(),
      targetId: z.string().uuid(),
      env: z.enum(["dev", "staging", "production"]),
      pageCount: z.number().int().nullable(),
      fileCount: z.number().int().nullable(),
      buildId: z.string(),
      publishSummary: z.record(z.string(), z.unknown()),
      /** The live host a rebuild rendered; null for a copied build. */
      siteUrl: z.string().nullable(),
      caeloVersion: z.string().nullable(),
      override: z.object({ auditRunId: z.string(), reason: z.string() }).nullable(),
      phaseTimings: z.array(phaseTimingSchema),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT status FROM deploy_runs WHERE id = ${input.runId}::uuid FOR UPDATE
    `)) as unknown as { status: string }[];
    if (rows.length === 0) {
      throw new OperationAbortError({
        kind: "HandlerError",
        operation: "deploy.promote",
        message: `Publish live run ${input.runId} has no row any more; its release is live but cannot be recorded. Publish live again.`,
      });
    }
    // The provider released this build: production serves it, whatever the
    // row says. A row the sweep ended (its heartbeat stopped for longer than
    // the lease mid-release) is corrected rather than left claiming the
    // previous build is live — the plugin-data build and rollback read
    // what is live from here.
    if (rows[0]?.status !== "running") {
      console.error(
        "[deploy] Publish live released after its run was marked failed; recording it",
        {
          runId: input.runId,
          status: rows[0]?.status,
        },
      );
    }
    // Released first: this transaction keeps the rows locked until it
    // commits, so nobody else publishes in between.
    await releaseStagingPublication(tx, input.runId);
    await releaseLiveRelease(tx, input.runId);
    if (input.env === "production") {
      // Epic #1107 — the pages of the build it ships get their
      // first_published_at — the staged run's start, which is what both
      // the staged build and its live rebuild rendered.
      await stampFirstPublished(tx, input.fromRunId);
      // #1155 — the promoted build baked its plugin data when it was
      // staged; bakes a plugin-data build made since are pending again.
      await rewindBakesToRun(tx, input.fromRunId);
    }
    // #553 — the publish-anyway decision is recorded only now that the
    // build it allowed is live; a failed Publish live leaves the gate closed.
    if (input.override) await recordProductionOverride(tx, ctx, input.override, "deploy.promote");
    await tx.execute(sql`
      UPDATE deploy_runs
      SET status = 'succeeded', finished_at = clock_timestamp(), error_message = NULL,
          phase_timings = ${jsonbParam(input.phaseTimings)},
          page_count = ${input.pageCount},
          file_count = ${input.fileCount},
          build_id = ${input.buildId},
          publish_summary = ${jsonbParam(input.publishSummary)},
          site_url = ${input.siteUrl},
          caelo_version = ${input.caeloVersion},
          lease_expires_at = NULL
      WHERE id = ${input.runId}::uuid
    `);
    // #1157 — the build carries the redirects table as it was at its
    // Stage; redirects saved since then must stay live. The target is
    // behind until the table as saved now is put on the build it serves —
    // after this commit (deploy.promote), so no provider I/O runs inside
    // this transaction.
    await markRedirectsBehind(tx, [input.targetId]);
    return ok({});
  },
});

/** #650 — the live rebuild differs from the staged build in more than the host. */
class ParityRefusalError extends Error {
  override readonly name = "ParityRefusalError";
}

type PublishResult = Awaited<ReturnType<StaticPublisher["promoteToProduction"]>>;

/**
 * #650 — for a build staged with its own staging host: rebuild main with
 * the live host into this run (without touching what is served) and
 * compare it file by file with the staged build's host-normalised
 * manifest. Throws {@link ParityRefusalError} naming the differing files,
 * or an Error for a failed rebuild.
 */
async function rebuildForLive(
  ctx: ExecutionContext,
  steps: OperationSteps,
  args: {
    readonly plan: PromotePlan;
    readonly publisher: StaticPublisher;
    readonly provider: string | undefined;
    readonly target: DeployTarget;
    readonly repoRoot: string;
    readonly timer: PhaseTimer;
    readonly stop: AbortSignal;
  },
): Promise<{ buildDir: string; pageCount: number; fileCount: number }> {
  const { plan } = args;
  if (!args.publisher.publishLiveBuild) {
    throw new Error(
      `staged build ${plan.fromRunId} was rendered for a separate staging host, but the ${args.provider ?? "self-hosted"} publisher cannot publish a rebuilt tree. Stage again so the build carries the live host.`,
    );
  }
  if (plan.parityManifest === null) {
    throw new Error(
      `staged build ${plan.fromRunId} has no parity manifest, so Publish live cannot prove the live build matches it. Stage again, then Publish live.`,
    );
  }
  const built = await runGenerator(steps.registry, steps.adapter, ctx, {
    cliPath: resolveGeneratorCli(),
    runId: plan.toRunId,
    target: args.target,
    repoRoot: args.repoRoot,
    publishAt: plan.publishAt,
    // Nothing may serve this build before the parity guard passed.
    syncCurrent: false,
    // #1211 — an uploading publisher keeps no builds in the container.
    retainBuilds: retainedBuildsFor(args.publisher),
    signal: args.stop,
  });
  if (built.ok) args.timer.include("generator", built.result.phases);
  args.timer.lap("generator");
  if (!built.ok) {
    const tail = built.stderr ? ` — ${built.stderr.slice(-300).trim()}` : "";
    throw new Error(`the live rebuild failed: ${built.message}${tail}`);
  }
  const diff = compareBuildManifests(
    plan.parityManifest,
    await buildManifestOf(built.result.buildDir),
  );
  const refusal = parityRefusal(diff, {
    stagingRunId: plan.fromRunId,
    stagedCaeloVersion: plan.stagedCaeloVersion,
    runningCaeloVersion: CAELO_VERSION,
  });
  args.timer.lap("parity");
  if (refusal) throw new ParityRefusalError(refusal);
  return {
    buildDir: built.result.buildDir,
    pageCount: built.result.pageCount,
    fileCount: built.result.fileCount,
  };
}

/** The body of deploy.promote (see the module comment). */
async function runPromote(
  ctx: ExecutionContext,
  input: z.infer<typeof promoteInput>,
  steps: OperationSteps,
): Promise<Result<z.infer<typeof promoteOutput>, QueryError>> {
  const { registry, adapter } = steps;
  const runId = input.runId ?? randomUUID();
  const ttlMs = DEPLOY_RUN_LEASE_TTL_MS;
  const started = await execute(registry, adapter, ctx, "deploy.start_promote", {
    fromTarget: input.fromTarget,
    toTarget: input.toTarget,
    ...(input.publishAnyway ? { publishAnyway: input.publishAnyway } : {}),
    runId,
    leaseTtlMs: ttlMs,
  });
  if (!started.ok) return err(started.error);
  // Started after the run's started_at was read (in deploy.start_promote),
  // so `finished_at - started_at` always covers the timed steps (#1003).
  const timer = new PhaseTimer();
  const plan = started.value as PromotePlan;
  const sys = systemContextOf(ctx);
  const provider = process.env.CAELO_PROVIDER;
  const repoRoot = resolveOutputRoot(input.repoRoot);
  const withStagingHost = plan.stagedSiteUrl !== null;

  const heartbeat = new DeployRunHeartbeat(async (): Promise<DeployRunBeat> => {
    const r = await execute(registry, adapter, sys, "deploy.renew_run_lease", { runId, ttlMs });
    if (!r.ok) throw new Error(describeError(r.error));
    return r.value as DeployRunBeat;
  }, DEPLOY_RUN_HEARTBEAT_MS);
  const stop = steps.signal ? AbortSignal.any([steps.signal, heartbeat.lost]) : heartbeat.lost;
  let publisher: StaticPublisher | null = null;
  let buildDir: string | null = null;

  /** Record the failure (releasing every lease) and answer with `reply`. */
  const fail = async (
    stored: string,
    reply: string = stored,
  ): Promise<Result<z.infer<typeof promoteOutput>, QueryError>> => {
    const r = await execute(registry, adapter, sys, "deploy.fail_run", {
      runId,
      message: stored,
      phaseTimings: timer.phases(),
    });
    // Unrecorded, the run's lease lapses and the next run marks it failed.
    if (!r.ok) console.error("[deploy] could not record the failed run", { runId, error: r.error });
    logRunTimings("publish-live", runId, timer, { status: "failed" });
    return refused(reply);
  };
  /** Proof, right before an irreversible provider step, that every lease is still this run's. */
  const fence = () =>
    fenceRunLeases(steps, sys, {
      runId,
      ttlMs,
      need: { publication: withStagingHost, liveRelease: true },
      lostMessage: (renewError) =>
        renewError !== null
          ? `Publish live ${runId} could not confirm it still holds its place in the publish order (${renewError}), so nothing was released. Publish live again.`
          : `Publish live ${runId} lost its place in the publish order (its lease lapsed), so nothing was released: another publish may have changed what is live. Publish live again.`,
    });

  try {
    timer.lap("prepare");
    // A rollback, plugin-data build or CDN purge must not release another
    // version mid-publish. Lock order: live release first, then staging.
    const live = await acquireLeaseStep(steps, sys, {
      op: "deploy.acquire_live_release",
      runId,
      ttlMs,
      stop,
      waitMs: LIVE_RELEASE_WAIT_MS,
      what: "live release slot",
      busyMessage: (heldBy) =>
        `${heldBy ? `another Publish live, rollback or plugin-data build (run ${heldBy})` : "a release of the previous Caelo version (during the update)"} kept releasing the live site for ${Math.round(LIVE_RELEASE_WAIT_MS / 60_000)} minutes, so nothing was published. Publish live again once it finished (Settings → Deployments shows it).`,
    });
    if (!live.ok) return await fail(live.message);
    heartbeat.expectLiveRelease(true);
    // #650 — no Stage may publish or prune previews until this publish has
    // decided what staging serves next. A Stage that is publishing right
    // now finishes first.
    let servedRunId: string | null = null;
    if (withStagingHost) {
      const slot = await acquireLeaseStep<{
        acquired: boolean;
        heldByRunId: string | null;
        servedRunId: string | null;
      }>(steps, sys, {
        op: "deploy.acquire_staging_publication",
        runId,
        ttlMs,
        stop,
        waitMs: STAGING_PUBLICATION_WAIT_MS,
        what: "staging publish slot",
        busyMessage: (heldBy) =>
          `a Stage is publishing the staging site right now (${heldBy ? `build ${heldBy}` : "a run of the previous Caelo version, during the update"}) and did not finish within ${Math.round(STAGING_PUBLICATION_WAIT_MS / 1000)} s. Nothing was published; Publish live again once that Stage finished (Settings → Deployments shows it).`,
      });
      if (!slot.ok) return await fail(slot.message);
      heartbeat.expectPublication(true);
      servedRunId = slot.value.servedRunId;
    }
    timer.lap("lock-wait");
    try {
      publisher = await loadStaticPublisher(provider);
    } catch (e) {
      return await fail(`promotion failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const target: DeployTarget = {
      ...plan.to,
      // v0.2.78 — on Cloud Run the row's out_dir resolves to a read-only path.
      outDir: effectiveOutDir(provider, plan.to.env, plan.to.outDir),
    };

    if (withStagingHost) {
      // staging.<domain> keeps serving what it serves — the build about to
      // go live, or a newer Stage — so after the release it shows the
      // published state instead of "nothing staged". Re-selecting it keeps
      // its preview alive even when it was staged before served previews
      // stopped expiring, and sweeps up previews a failed retirement left.
      // Done before the release, so a failure publishes nothing; retiring
      // other previews needs proof this run still holds the staging slot.
      const proof = await fence();
      if (!proof.ok) return await fail(proof.message);
      try {
        await selectServedStagingPreview(publisher, servedRunId, { retireUntil: proof.until });
      } catch (e) {
        timer.lap("select-preview");
        return await fail(`promotion failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      timer.lap("select-preview");
    }

    // #650 — a build staged with its own staging host cannot be copied live
    // (every absolute URL names staging.<domain>): rebuild the same content
    // with the live host, prove it differs only in the host, and publish the
    // rebuild. A build staged with the live host is copied as before.
    let rebuilt: { buildDir: string; pageCount: number; fileCount: number } | null = null;
    if (withStagingHost) {
      // #1211 — every way out deletes what the generator wrote (finally).
      buildDir = buildDirOf(repoRoot, target.outDir, runId);
      try {
        rebuilt = await rebuildForLive(ctx, steps, {
          plan,
          publisher,
          provider,
          target,
          repoRoot,
          timer,
          stop,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // The parity guard's refusal already says what happened and what
        // to do next; anything else is an unexpected publish failure.
        return await fail(
          message,
          e instanceof ParityRefusalError ? message : `promotion failed: ${message}`,
        );
      }
    }

    // The last point a stop is honoured: past the fence the provider
    // releases the new version and the run must be recorded.
    if (stop.aborted) return await fail(abortMessage(stop));
    const proof = await fence();
    if (!proof.ok) return await fail(proof.message);
    let summary: PublishResult;
    try {
      // v0.2.78 — delegate to the per-provider StaticPublisher. Self-hosted
      // does the copyTreeExcept + syncContents overlay; cloud does
      // cross-bucket server-side object copies or a version release.
      summary =
        rebuilt !== null && publisher.publishLiveBuild
          ? await publisher.publishLiveBuild({
              buildDir: rebuilt.buildDir,
              runId,
              target,
              sourceRunId: plan.fromRunId,
            })
          : await publisher.promoteToProduction({
              sourceRunId: plan.buildId,
              sourceBuildDir: resolve(repoRoot, plan.from.outDir, "builds", plan.buildId),
              fromTarget: plan.from,
              toTarget: plan.to,
              siteBaseUrl: plan.siteBaseUrl,
            });
    } catch (e) {
      timer.lap("publish");
      return await fail(`promotion failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const { phases: publishPhases, ...published } = summary;
    timer.include("publish", publishPhases ?? []);
    timer.lap("publish");

    timer.lap("finish");
    const finished = await execute(registry, adapter, ctx, "deploy.finish_promote", {
      runId,
      fromRunId: plan.fromRunId,
      targetId: plan.to.id,
      env: plan.to.env,
      pageCount: rebuilt ? rebuilt.pageCount : plan.stagedPageCount,
      fileCount: rebuilt ? rebuilt.fileCount : plan.stagedFileCount,
      buildId: published.destinationBuildId,
      publishSummary: published as Record<string, unknown>,
      siteUrl: rebuilt ? plan.siteBaseUrl : null,
      // #834 — a rebuild is rendered by this version; a copy keeps the
      // version that rendered the copied build.
      caeloVersion: rebuilt ? CAELO_VERSION : plan.stagedCaeloVersion,
      override: plan.override,
      phaseTimings: timer.phases(),
    });
    if (!finished.ok) {
      return await fail(
        `the new build is live, but recording it failed: ${describeError(finished.error)}. Settings → Deployments may not show it as live; Publish live again to record it.`,
      );
    }
    // The run is recorded; now put the redirects table on the build the
    // target serves, in a transaction of its own. A failure is recorded and
    // retried by the redirect-sync worker (the target stays behind); the
    // files are live either way.
    const synced = await execute(registry, adapter, sys, "redirects.sync_provider", {
      trigger: "publish",
      targetIds: [plan.to.id],
      ...(input.repoRoot ? { repoRoot: input.repoRoot } : {}),
    });
    if (!synced.ok) {
      console.error("[deploy] redirects not synced after Publish live; retried automatically", {
        runId,
        error: describeError(synced.error),
      });
    }
    // Last fallible step done: one line per run, never succeeded + failed.
    logRunTimings("publish-live", runId, timer, { status: "succeeded" });
    return ok({ fromRunId: plan.fromRunId, toRunId: runId, buildId: published.destinationBuildId });
  } catch (e) {
    // A throw past the steps above is a bug; the run still ends failed and
    // releases its leases instead of waiting for them to lapse.
    timer.lap("failed-step");
    return await fail(
      `promotion failed: an unexpected error stopped it: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    await heartbeat.stop();
    // Uploaded, refused or failed: the provider holds what goes live, not
    // /tmp (memory on Cloud Run).
    if (publisher && buildDir) await removeUploadedBuild(publisher, buildDir);
  }
}

export const promoteDeployOp = defineStepwiseOperation({
  name: "deploy.promote",
  // Why human-only: Ops-level decision per CMS_REQUIREMENTS §6 (staging → production gate).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: promoteInput,
  output: promoteOutput,
  stepwise: runPromote,
});
