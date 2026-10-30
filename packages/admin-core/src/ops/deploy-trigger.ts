// SPDX-License-Identifier: MPL-2.0

/**
 * `deploy.trigger` — Stage, and every other build of a target (an Owner's
 * production build, a dev build). Trigger-only AI surface
 * (CMS_REQUIREMENTS §3.1): the AI may request a non-production build; the
 * generator is a separate subprocess the AI cannot reach.
 *
 * #1211 — the trigger holds NO database transaction while the generator
 * and the provider upload run. It is a step-wise op
 * (`defineStepwiseOperation`): every database step is a short op of its
 * own, committed on its own:
 *
 *   deploy.start_trigger   the gates (SEO, plugins, quality, AI scope), the
 *                          run row committed as `running` with its lease
 *   themes.ensure_favicon_rendition
 *   (generator)            no transaction; progress via deploy.update_progress
 *   deploy.acquire_staging_publication  (a Stage with its own staging host)
 *   (publisher upload)     no transaction
 *   deploy.finish_trigger  record the origin + the run, release the lease,
 *                          mark the target's redirects behind
 *   redirects.sync_provider push the redirects (provider I/O, after the
 *                          run is recorded; a failure is retried)
 *   deploy.fail_run        on every failure or abort: record it, release
 *
 * A heartbeat (deploy.renew_run_lease) keeps the run's lease — and the
 * staging-publication lease while it holds it — alive. When the caller
 * aborts (the operator's Stop) the generator is killed, nothing more is
 * published, and the run ends failed with every lease released, so the
 * chat can Stage again at once (#1204). A process that dies mid-run stops
 * renewing; its leases lapse and the next run marks it failed.
 *
 * Before #1211 one transaction held a pooled connection for the whole
 * Stage while its own progress writes took more from the same pool: on
 * production a 34 s Stage took 852 s and the chat stayed locked (#1204).
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
import { buildManifestOf, hostNormaliser } from "../deploy/build-parity.js";
import {
  DEPLOY_RUN_HEARTBEAT_MS,
  DEPLOY_RUN_LEASE_TTL_MS,
  type DeployRunBeat,
  DeployRunHeartbeat,
} from "../deploy/deploy-run-lock.js";
import { draftPagesSummary, mainDraftPages } from "../deploy/draft-pages.js";
import {
  abortMessage,
  resolveGeneratorCli,
  runGenerator,
  systemContextOf,
} from "../deploy/generator-subprocess.js";
import {
  describeMissingMetaDescriptions,
  pagesMissingMetaDescription,
} from "../deploy/missing-seo.js";
import { resolveOutputRoot } from "../deploy/output-root.js";
import {
  activePluginProblems,
  deployPluginProblem,
  describePluginProblems,
  reconcilePluginsForBuild,
} from "../deploy/plugin-problems.js";
import { markRedirectsBehind } from "../deploy/redirect-sync.js";
import { stagingSiteUrl } from "../deploy/staging-domain.js";
import {
  releaseStagingPublication,
  STAGING_PUBLICATION_WAIT_MS,
} from "../deploy/staging-publication-lock.js";
import { loadStaticPublisher, type StaticPublisher } from "../deploy/static-publisher.js";
import { truncatedListSchema } from "../deploy/truncated-lists.js";
import { unpublishedLinkTargetSchema } from "../deploy/unpublished-links.js";
import { verifyStagedBuildServed } from "../deploy/verify-staged-serve.js";
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
import {
  checkProductionBuildGate,
  type ProductionOverride,
  recordProductionOverride,
} from "./quality/production-gate.js";
import { computeRenderFingerprint } from "./quality/render-fingerprint.js";
import { setStagingOrigin } from "./staging_access.js";

const triggerInput = z.object({
  targetName: z.string().optional(),
  repoRoot: z.string().optional(),
  /** P13 ideas-pass — when supplied, the static-generator
   *  re-bakes only these pages. Other pages keep their cached HTML.
   *  Omitted = full-site rebuild. */
  changedPageIds: z.array(z.string().uuid()).optional(),
  /**
   * Epic #1107 — shared lists and list types changed since the last
   * build. With them (or changedPageIds) the build is incremental: the
   * generator rebuilds the changed pages plus every page whose recorded
   * render dependencies the change reaches (`render-deps.json`).
   */
  changedListIds: z.array(z.string().uuid()).optional(),
  changedListTypeIds: z.array(z.string().uuid()).optional(),
  /**
   * #553 — a human's explicit decision to build PRODUCTION although the
   * staged build's quality check failed (no result). Recorded on the
   * audit run; ignored for anything but a failed check.
   */
  publishAnyway: z
    .object({ reason: z.string().trim().min(3).max(500) })
    .strict()
    .optional(),
  /**
   * #1211 — the id the run gets, minted by a caller that must name the run
   * before the build is done (stage_changes answers "still running, run X"
   * when the build outlasts its wait). Default: a fresh id.
   */
  runId: z.string().uuid().optional(),
});

const triggerOutput = z.object({
  runId: z.string(),
  targetName: z.string(),
  pageCount: z.number().int(),
  fileCount: z.number().int(),
  durationMs: z.number().int(),
  /** Where the run spent its time, step by step (also in deploy_runs.phase_timings). */
  phases: z.array(phaseTimingSchema),
  buildId: z.string(),
  /**
   * Where the staged build can be looked at. #650 — on a provider whose
   * staging has its own protected host, that host
   * (`https://staging.<domain>/`); otherwise the provider's preview URL
   * when it has one, undefined where the form action builds the URL.
   */
  previewUrl: z.string().optional(),
  /**
   * #678 — main's draft pages, which this build does NOT contain (only
   * status='published' pages are built). Reported so a "successful"
   * build never hides missing pages.
   */
  draftPages: draftPagesSummary,
  /**
   * #724 — pages this build links to that it does not contain (drafts).
   * A Stage warning; Publish live blocks on them (rollout F).
   */
  unpublishedLinkTargets: z.array(unpublishedLinkTargetSchema),
  /**
   * #1257 — page lists cut at the query cap: more pages match than they
   * show. A Stage warning; paginating the list fixes it.
   */
  truncatedLists: z.array(truncatedListSchema),
  /**
   * #1008 — active plugins that were not running when this build ran,
   * so it lacks their output. A Stage warning; such a Stage is never
   * published, and a production build refuses instead.
   */
  pluginProblems: z.array(deployPluginProblem),
});

/** What deploy.start_trigger hands the rest of the run. */
const startPlan = z.object({
  runId: z.string(),
  target: targetRow,
  /** The run's first-publication instant (its committed started_at). */
  publishAt: z.string(),
  /** #650 — the staging host this build renders, or null. */
  stagingOrigin: z.string().nullable(),
  /** The live host, for the parity fingerprint of a build with its own staging host. */
  siteBaseUrl: z.string().nullable(),
  pluginProblems: z.array(deployPluginProblem),
  /** #553 — the publish-anyway decision a production build carries. */
  override: z.object({ auditRunId: z.string(), reason: z.string() }).nullable(),
});
type StartPlan = z.infer<typeof startPlan>;

/** Record a run that a gate refused before it started (Ops and the bell show it). */
async function recordBlockedRun(
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  ctx: ExecutionContext,
  args: { targetId: string; startedAt: string; message: string; pluginProblems?: unknown },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at, error_message,
                             plugin_problems)
    VALUES (${args.targetId}::uuid, ${ctx.actorId}::uuid, 'failed', ${args.startedAt}::timestamptz,
            clock_timestamp(), ${args.message},
            ${args.pluginProblems === undefined ? sql`NULL` : jsonbParam(args.pluginProblems)})
  `);
}

export const startTriggerOp = defineOperation({
  name: "deploy.start_trigger",
  // Why site-wide: the build it starts reads the whole site.
  readScope: "site",
  // The first step of deploy.trigger, run under the trigger's own context:
  // its gates decide on the caller (an AI may not build production, a
  // production build passes the quality gate as the human who asked).
  // Every actor deploy.trigger admits reaches it; no AI tool wraps it.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: triggerInput.omit({ runId: true }).extend({
    runId: z.string().uuid(),
    leaseTtlMs: z.number().int().min(1_000).max(3_600_000),
  }),
  output: startPlan,
  handler: async (ctx, input, tx) => {
    const startedAt = await runStartedAt(tx);
    const targetRows = (await tx.execute(
      input.targetName
        ? sql`SELECT ${TARGET_COLUMNS} FROM deploy_targets WHERE name = ${input.targetName} LIMIT 1`
        : sql`SELECT ${TARGET_COLUMNS} FROM deploy_targets WHERE is_default LIMIT 1`,
    )) as unknown as TargetDbRow[];
    const target = targetRows[0];
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "deploy.trigger",
        message: input.targetName
          ? `target not found: ${input.targetName}`
          : "no default target configured",
      });
    }
    // Production reaches visitors, so it ships only through the §11.A
    // gate (deploy.propose_promote → Owner Approve), never through a
    // direct AI trigger. Dev/staging rebuilds stay AI-callable — staging
    // is noindex and exists precisely to be rebuilt and inspected.
    if (ctx.actorKind === "ai" && target.env === "production") {
      return err({
        kind: "HandlerError",
        operation: "deploy.trigger",
        message:
          `target "${target.name}" is a production target — the AI cannot deploy it directly. ` +
          "Rebuild staging with deploy_staging, then call propose_deploy_promote (fromTarget = the staging target) so the Owner approves the go-live.",
      });
    }
    // #1154 — nothing reaches production without a human: a production
    // build is an Owner-initiated build or a human Publish live, never a
    // background job.
    const automatic = productionNeedsHuman(ctx, target.env, "deploy.trigger");
    if (automatic) return err(automatic);

    // CLAUDE.md §2 SEO fill-once — no page is built for staging or
    // production without a meta description (deploy/missing-seo.ts). Before
    // the quality gate: a publish-anyway override is about a failed
    // Lighthouse run, never about missing SEO. Recorded as a failed run so
    // Ops and the bell show it. Dev builds stay unchecked — they are local
    // previews, never served to visitors.
    if (target.env === "staging" || target.env === "production") {
      const missingSeo = describeMissingMetaDescriptions(await pagesMissingMetaDescription(tx));
      if (missingSeo) {
        await recordBlockedRun(tx, ctx, {
          targetId: target.id,
          startedAt,
          message: `Blocked, missing SEO: ${missingSeo}`,
        });
        return err({ kind: "HandlerError", operation: "deploy.trigger", message: missingSeo });
      }
    }
    // #1008 — a site built without an active plugin lacks what it adds. A
    // Stage records and reports it; production refuses (no override: the
    // fix is to get the plugin running, not to ship without it).
    const pluginProblems =
      target.env === "staging" || target.env === "production" ? await activePluginProblems(tx) : [];
    if (target.env === "production" && pluginProblems.length > 0) {
      const message = describePluginProblems(pluginProblems);
      await recordBlockedRun(tx, ctx, {
        targetId: target.id,
        startedAt,
        message: `Blocked, plugins not running: ${message}`,
        pluginProblems,
      });
      return err({ kind: "HandlerError", operation: "deploy.trigger", message });
    }
    // #553 — a production build publishes what is staged, so it passes the
    // same quality gate as Publish live (production-gate.ts). A refusal is
    // recorded as a failed run, so Ops and the notification bell show it.
    let override: ProductionOverride | null = null;
    if (target.env === "production") {
      const gate = await checkProductionBuildGate(tx, ctx, input.publishAnyway);
      if (!gate.ok) {
        await recordBlockedRun(tx, ctx, {
          targetId: target.id,
          startedAt,
          message: `Blocked by the quality gate: ${gate.message}`,
        });
        return err({ kind: "HandlerError", operation: "deploy.trigger", message: gate.message });
      }
      override = gate.override;
    }

    // #650 — on a provider whose staging has its own host, a staging build
    // renders that host into every absolute URL (canonical, sitemap,
    // og:url, hreflang, robots) so staging.<domain> is self-consistent for
    // crawlers. Resolved before the run row exists: a missing host is a
    // provisioning error, not a build failure.
    let stagingOrigin: string | null = null;
    if (target.env === "staging") {
      try {
        stagingOrigin = await stagingSiteUrl(tx, process.env.CAELO_PROVIDER);
      } catch (e) {
        return err({
          kind: "HandlerError",
          operation: "deploy.trigger",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // #553 — a staging build records main's render fingerprint as it
    // starts, so a later direct production build can tell whether main
    // still renders what this Stage's quality check saw (taken before the
    // generator runs: a change landing mid-build counts as unchecked).
    const fingerprint = target.env === "staging" ? await computeRenderFingerprint(tx) : null;

    // The run row commits with this transaction, as `running` with its
    // lease: the deployments page shows it and its progress lands.
    await beginRunInTx(tx, {
      runId: input.runId,
      targetId: target.id,
      actorId: ctx.actorId,
      startedAt,
      renderFingerprint: fingerprint,
      // #834 — the Caelo version rendering this build: Publish live's
      // parity guard names an upgrade between Stage and Publish live.
      caeloVersion: CAELO_VERSION,
      // #1008 — which active plugins did not run for this build; Publish
      // live refuses a Stage that has any (null: a dev build, not checked).
      pluginProblems: target.env === "dev" ? null : pluginProblems,
      buildKind: "site",
      baseRunId: null,
      leaseTtlMs: input.leaseTtlMs,
    });
    return ok({
      runId: input.runId,
      target: rowToTarget(target),
      publishAt: await deployRunStartedAt(tx, input.runId),
      stagingOrigin,
      // What Publish live's parity guard swaps the staging host back to.
      siteBaseUrl: stagingOrigin ? (await readSeoSettings(tx)).siteBaseUrl : null,
      pluginProblems,
      override,
    });
  },
});

export const finishTriggerOp = defineOperation({
  name: "deploy.finish_trigger",
  // Why site-wide: recording a build records the whole site's build output.
  readScope: "site",
  // The last step of deploy.trigger, run under the trigger's own context
  // (the publish-anyway decision is recorded as the human who made it).
  // Every actor deploy.trigger admits reaches it; no AI tool wraps it.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      runId: z.string().uuid(),
      targetId: z.string().uuid(),
      env: z.enum(["dev", "staging", "production"]),
      pageCount: z.number().int(),
      fileCount: z.number().int(),
      publishSummary: z.record(z.string(), z.unknown()),
      /** #650 — set for a Stage with its own staging host: it held the lease. */
      stagingOrigin: z.string().nullable(),
      parityManifest: z.record(z.string(), z.string()).nullable(),
      override: z.object({ auditRunId: z.string(), reason: z.string() }).nullable(),
      phaseTimings: z.array(phaseTimingSchema),
    })
    .strict(),
  output: z.object({ draftPages: draftPagesSummary }),
  handler: async (ctx, input, tx) => {
    // Refusals throw OperationAbortError: nothing of this step may commit,
    // the caller records the failure (deploy.fail_run).
    const refuse = (message: string): never => {
      throw new OperationAbortError({
        kind: "HandlerError",
        operation: "deploy.trigger",
        message,
      });
    };
    const running = (await tx.execute(sql`
      SELECT 1 AS running FROM deploy_runs
      WHERE id = ${input.runId}::uuid AND status = 'running'
      FOR UPDATE
    `)) as unknown as { running: number }[];
    if (running.length === 0) {
      refuse(
        `build ${input.runId} was marked failed while it ran (its heartbeat stopped for longer than the lease); nothing it built is recorded. Stage again.`,
      );
    }
    if (input.stagingOrigin) {
      // Released first: this transaction keeps the row locked until it
      // commits, so the redirect sync below sees it free and no other
      // publish gets in between.
      const held = await releaseStagingPublication(tx, input.runId);
      if (held !== true) {
        refuse(
          `staging build ${input.runId} lost its place in the staging publish order (its lease lapsed), so another Stage or Publish live may have changed what staging serves. Staging keeps serving that; Stage again.`,
        );
      }
      // #650 / #908 — the build staging serves now, and the origin the
      // gateway proxies to.
      const previewUrl = input.publishSummary.previewUrl;
      await setStagingOrigin(tx, {
        originUrl: typeof previewUrl === "string" ? previewUrl : null,
        runId: input.runId,
      });
    }
    // The publish-anyway decision is recorded only now that the build it
    // allowed is live; a failed build leaves the quality gate closed.
    if (input.override) {
      await recordProductionOverride(tx, ctx, input.override, "deploy.trigger");
    }
    // Epic #1107 — a production build is a Publish live: pages it ships
    // for the first time get their first_published_at.
    if (input.env === "production") await stampFirstPublished(tx, input.runId);
    await tx.execute(sql`
      UPDATE deploy_runs
      SET status = 'succeeded', finished_at = clock_timestamp(),
          phase_timings = ${jsonbParam(input.phaseTimings)},
          page_count = ${input.pageCount},
          file_count = ${input.fileCount},
          build_id = ${input.runId},
          publish_summary = ${jsonbParam(input.publishSummary)},
          site_url = ${input.stagingOrigin},
          parity_manifest = ${input.parityManifest === null ? null : jsonbParam(input.parityManifest)},
          lease_expires_at = NULL
      WHERE id = ${input.runId}::uuid
    `);
    // #1157 — the build read the redirects table when it started; a
    // redirect saved since then was pushed to what the target served before
    // this build. The target is behind until the table as saved now is put
    // on the build it serves now — after this commit (deploy.trigger), so
    // no provider I/O runs inside this transaction (#1211).
    await markRedirectsBehind(tx, [input.targetId]);
    return ok({ draftPages: await mainDraftPages(tx) });
  },
});

type TriggerOutput = z.infer<typeof triggerOutput>;

/** The body of deploy.trigger (see the module comment). */
async function runTrigger(
  ctx: ExecutionContext,
  input: z.infer<typeof triggerInput>,
  steps: OperationSteps,
): Promise<Result<TriggerOutput, QueryError>> {
  const { registry, adapter } = steps;
  const runId = input.runId ?? randomUUID();
  const ttlMs = DEPLOY_RUN_LEASE_TTL_MS;
  // #1008 — the plugin gate decides on what runs here; reconciled first,
  // outside any transaction (plugin-problems.ts).
  const unreconciled = await reconcilePluginsForBuild();
  if (unreconciled !== null) {
    return err({ kind: "HandlerError", operation: "deploy.trigger", message: unreconciled });
  }
  const started = await execute(registry, adapter, ctx, "deploy.start_trigger", {
    ...input,
    runId,
    leaseTtlMs: ttlMs,
  });
  if (!started.ok) return err(started.error);
  // Started after the run's started_at was read (in deploy.start_trigger),
  // so `finished_at - started_at` always covers the timed steps (#1003).
  const timer = new PhaseTimer();
  const plan = started.value as StartPlan;
  const sys = systemContextOf(ctx);
  const runKind = plan.target.env === "staging" ? "stage" : "build";
  const provider = process.env.CAELO_PROVIDER;
  const repoRoot = resolveOutputRoot(input.repoRoot);
  const target: DeployTarget = {
    ...plan.target,
    // v0.2.78 — on Cloud Run the row's out_dir resolves to a read-only
    // path; builds go to /tmp/caelo-builds/<env> and are uploaded at once.
    outDir: effectiveOutDir(provider, plan.target.env, plan.target.outDir),
  };
  // Where the generator writes this run's build (generate.ts).
  const buildDir = buildDirOf(repoRoot, target.outDir, runId);

  const heartbeat = new DeployRunHeartbeat(async (): Promise<DeployRunBeat> => {
    const r = await execute(registry, adapter, sys, "deploy.renew_run_lease", { runId, ttlMs });
    if (!r.ok) throw new Error(describeError(r.error));
    return r.value as DeployRunBeat;
  }, DEPLOY_RUN_HEARTBEAT_MS);
  const stop = steps.signal ? AbortSignal.any([steps.signal, heartbeat.lost]) : heartbeat.lost;
  let publisher: StaticPublisher | null = null;

  /** Record the failure (releasing every lease) and answer with `reply`. */
  const fail = async (
    stored: string,
    reply: string = stored,
  ): Promise<Result<TriggerOutput, QueryError>> => {
    const r = await execute(registry, adapter, sys, "deploy.fail_run", {
      runId,
      message: stored,
      phaseTimings: timer.phases(),
    });
    // Unrecorded, the run's lease lapses and the next run marks it failed.
    if (!r.ok) console.error("[deploy] could not record the failed run", { runId, error: r.error });
    logRunTimings(runKind, runId, timer, { status: "failed" });
    return err({ kind: "HandlerError", operation: "deploy.trigger", message: reply });
  };

  try {
    // The active theme's raster favicon ships as its 64 px rendition
    // (ops/media_favicon.ts). One bound before that rule has none: create
    // it from the stored original now, so an upgraded install needs no
    // manual step. A failure (original missing / undecodable) fails the
    // build loudly.
    const fav = await execute(registry, adapter, ctx, "themes.ensure_favicon_rendition", {});
    if (!fav.ok) {
      timer.lap("prepare");
      const message =
        fav.error.kind === "HandlerError" ? fav.error.message : JSON.stringify(fav.error);
      return await fail(`Blocked, favicon: ${message}`, message);
    }
    // Loaded before the build: the publisher decides whether the build is
    // mirrored into `current/` (#1003 — only a serving layer that reads it
    // needs the copy) and whether builds stay on disk (#1211).
    try {
      publisher = await loadStaticPublisher(provider);
    } catch (e) {
      timer.lap("prepare");
      return await fail(`publish failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    timer.lap("prepare");

    const subprocess = await runGenerator(registry, adapter, ctx, {
      cliPath: resolveGeneratorCli(),
      runId,
      target,
      repoRoot,
      publishAt: plan.publishAt,
      changedPageIds: input.changedPageIds,
      changedListIds: input.changedListIds,
      changedListTypeIds: input.changedListTypeIds,
      ...(plan.stagingOrigin ? { siteBaseUrlOverride: plan.stagingOrigin } : {}),
      syncCurrent: publisher.servesCurrentDir,
      retainBuilds: retainedBuildsFor(publisher),
      signal: stop,
    });
    if (subprocess.ok) timer.include("generator", subprocess.result.phases);
    timer.lap("generator");
    if (!subprocess.ok) {
      const tail = subprocess.stderr ? `\n${subprocess.stderr.slice(-500)}` : "";
      // v0.2.77 — the stderr tail rides in the error so the operator's
      // toast carries the real reason, not just "exited 1".
      const stderrTail = subprocess.stderr ? ` — ${subprocess.stderr.slice(-300).trim()}` : "";
      return await fail(
        subprocess.message + tail,
        `generator failed: ${subprocess.message}${stderrTail}`,
      );
    }
    const built = subprocess.result;
    // #1211 — a publisher that serves `current/` (self-hosted) is serving
    // this build already: the generator mirrored it and could not be
    // stopped while it did. A stop from here on cannot unpublish it, so the
    // run is recorded instead of reported as "nothing was published".
    const servedByGenerator = publisher.servesCurrentDir;

    // #650 — publishing a preview, recording it as the staging origin and
    // pruning the others is one ordered step per Stage: a concurrent Stage
    // must not prune this channel between its creation and our record.
    if (plan.stagingOrigin) {
      const slot = await acquireLeaseStep(steps, sys, {
        op: "deploy.acquire_staging_publication",
        runId,
        ttlMs,
        stop,
        waitMs: STAGING_PUBLICATION_WAIT_MS,
        what: "staging publish slot",
        busyMessage: (heldBy) =>
          `${heldBy ? `another Stage or Publish live (build ${heldBy})` : "a Publish live"} kept publishing the staging site for ${Math.round(STAGING_PUBLICATION_WAIT_MS / 60_000)} minutes, so this build was not published. Stage again once it finished (Settings → Deployments shows it).`,
      });
      timer.lap("lock-wait");
      if (!slot.ok) return await fail(slot.message);
      heartbeat.expectPublication(true);
    }
    if (stop.aborted && !servedByGenerator) return await fail(abortMessage(stop));

    // v0.2.78 — hand off to the per-provider StaticPublisher. Self-hosted
    // is a no-op (the generator already synced into current/); cloud
    // uploads to the staging bucket / preview channel.
    let publishSummary: Record<string, unknown>;
    try {
      const { phases: publishPhases, ...summary } = await publisher.publishStaging({
        buildDir: built.buildDir,
        runId,
        target,
      });
      publishSummary = summary as Record<string, unknown>;
      timer.include("publish", publishPhases ?? []);
      timer.lap("publish");
    } catch (e) {
      timer.lap("publish");
      const message = `publish failed: ${e instanceof Error ? e.message : String(e)}`;
      return await fail(message);
    }

    // Migration run #9 R10 (issue #262) — a self-hosted staging deploy only
    // counts as succeeded when the staging serving layer actually serves
    // THIS build (verified through the operator's Preview URL). Cloud
    // publishers surface their own previewUrl; test harnesses without a
    // serving layer opt out via CAELO_SKIP_STAGING_SERVE_CHECK.
    const isSelfHosted = !provider || provider === "self-hosted";
    if (
      isSelfHosted &&
      plan.target.env === "staging" &&
      process.env.CAELO_SKIP_STAGING_SERVE_CHECK !== "1"
    ) {
      const stagingBaseUrl = process.env.CAELO_STAGING_BASE_URL ?? "http://localhost:8081";
      const check = await verifyStagedBuildServed({ stagingBaseUrl, runId });
      timer.lap("verify-served");
      if (!check.served) {
        const outputRoot = resolve(repoRoot, target.outDir);
        return await fail(
          `staging build verification failed: ${check.reason}. ` +
            `This build was written to ${outputRoot} — if the serving layer (e.g. the dev-compose caddy-staging container) mounts a different directory, ` +
            "set CAELO_OUTPUT_ROOT to the directory the serving layer mounts (dev compose: <checkout>/apps/admin) and re-run the Stage.",
        );
      }
    }

    // #650 — what Publish live's parity guard compares against: this
    // build's content with the staging host swapped back to the live one.
    // Hashed now, while the build directory is on this instance.
    let parityManifest: Record<string, string> | null = null;
    if (plan.stagingOrigin) {
      try {
        parityManifest = await buildManifestOf(
          built.buildDir,
          hostNormaliser(plan.stagingOrigin, plan.siteBaseUrl ?? ""),
        );
      } catch (e) {
        timer.lap("parity");
        return await fail(
          `staging build ${runId} could not be fingerprinted for Publish live's parity check: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      timer.lap("parity");
      // The last point a stop is honoured: selecting the preview retires
      // the one staging serves, so from here on the run must be recorded.
      if (stop.aborted) return await fail(abortMessage(stop));
      // Selecting retires every other preview, so it needs PROOF that this
      // run still holds the staging publish slot — not the heartbeat's
      // last word, which may be minutes old when beats failed. One renewal
      // now proves it and keeps it for a full TTL from before the call;
      // retiring stops halfway through that window.
      const fence = await fenceRunLeases(steps, sys, {
        runId,
        ttlMs,
        need: { publication: true, liveRelease: false },
        lostMessage: (renewError) =>
          renewError !== null
            ? `staging build ${runId} was published, but could not confirm it still holds the staging publish slot (${renewError}), so it did not take over staging. Staging still serves the previous build; Stage again.`
            : `staging build ${runId} lost its place in the staging publish order (its lease lapsed), so it did not take over staging: another Stage or Publish live may have changed what staging serves. Stage again.`,
      });
      if (!fence.ok) return await fail(fence.message);
      // #650 / #908 — staging.<domain> now serves this build: its preview
      // becomes the served one (kept alive, every other preview retired);
      // deploy.finish_trigger records it as the origin.
      try {
        await selectServedStagingPreview(publisher, runId, { retireUntil: fence.until });
      } catch (e) {
        timer.lap("select-preview");
        return await fail(
          `staging build ${runId} was published but could not be made the build staging serves: ${e instanceof Error ? e.message : String(e)}. Staging still serves the previous build; Stage again.`,
        );
      }
      timer.lap("select-preview");
    } else if (stop.aborted && !servedByGenerator) {
      return await fail(abortMessage(stop));
    }

    timer.lap("finish");
    const finished = await execute(registry, adapter, ctx, "deploy.finish_trigger", {
      runId,
      targetId: plan.target.id,
      env: plan.target.env,
      pageCount: built.pageCount,
      fileCount: built.fileCount,
      publishSummary,
      stagingOrigin: plan.stagingOrigin,
      parityManifest,
      override: plan.override,
      phaseTimings: timer.phases(),
    });
    if (!finished.ok) return await fail(describeError(finished.error));
    // The run is recorded; now put the redirects table on the build the
    // target serves, in a transaction of its own. A failure is recorded and
    // retried by the redirect-sync worker (the target stays behind); it
    // does not undo the Stage.
    if (plan.target.env !== "dev") {
      const synced = await execute(registry, adapter, sys, "redirects.sync_provider", {
        trigger: "build",
        targetIds: [plan.target.id],
        ...(input.repoRoot ? { repoRoot: input.repoRoot } : {}),
      });
      if (!synced.ok) {
        console.error("[deploy] redirects not synced after the build; retried automatically", {
          runId,
          error: describeError(synced.error),
        });
      }
    }
    logRunTimings(runKind, runId, timer, {
      status: "succeeded",
      pageCount: built.pageCount,
      fileCount: built.fileCount,
    });

    // #650 — where staging has its own host, that host is the only staging
    // URL anyone is shown; the provider's preview origin stays internal.
    const providerPreview =
      typeof publishSummary.previewUrl === "string" ? publishSummary.previewUrl : undefined;
    const previewUrl = plan.stagingOrigin ? `${plan.stagingOrigin}/` : providerPreview;
    return ok({
      runId,
      targetName: plan.target.name,
      pageCount: built.pageCount,
      fileCount: built.fileCount,
      durationMs: built.durationMs,
      phases: timer.phases(),
      buildId: runId,
      ...(previewUrl ? { previewUrl } : {}),
      draftPages: (finished.value as { draftPages: z.infer<typeof draftPagesSummary> }).draftPages,
      unpublishedLinkTargets: built.unpublishedLinkTargets,
      truncatedLists: built.truncatedLists,
      pluginProblems: plan.pluginProblems,
    });
  } catch (e) {
    // A throw past the steps above is a bug; the run still ends failed and
    // releases its leases instead of waiting for them to lapse.
    timer.lap("failed-step");
    return await fail(
      `the build stopped on an unexpected error: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    await heartbeat.stop();
    // #1211 — uploaded or failed: an uploading publisher keeps no build in
    // the container's /tmp (memory on Cloud Run). The parity fingerprint
    // above was taken first.
    if (publisher) await removeUploadedBuild(publisher, buildDir);
  }
}

export const triggerDeployOp = defineStepwiseOperation({
  name: "deploy.trigger",
  // Why site-wide: a build reads every page, module, list and asset of the site.
  readScope: "site",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: triggerInput,
  output: triggerOutput,
  stepwise: runTrigger,
});
