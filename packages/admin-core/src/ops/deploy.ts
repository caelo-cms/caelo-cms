// SPDX-License-Identifier: MPL-2.0

/**
 * Phase 6 — deploy ops. Trigger-only AI surface (CMS_REQUIREMENTS §3.1):
 * `deploy.trigger` accepts `actorScope: ["human", "ai", "system"]` so the
 * AI can request a deploy via a tool call, but the generator is a
 * separate Bun subprocess (P6.2 #5) that AI cannot reach — its binary
 * lives in `apps/static-generator/src/cli.ts` and the only way it gets
 * spawned is via this op handler.
 *
 * P6.2 layout per env:
 *   output/<env>/builds/<runId>/   ← per-build immutable archive
 *   output/<env>/current/          ← regular dir mirroring the live build
 *
 * Caddy bind-mounts onto `output/<env>` and serves from `/srv/current`.
 * Each deploy syncs the new build into `current/` (file-by-file, inode
 * stable). Promote materialises a per-target overlay build that copies
 * the source's HTML but uses the destination's robots.txt + manifest,
 * then syncs the overlay into the destination's `current/`. Rollback
 * re-syncs any prior succeeded build's archive into `current/`.
 *
 * `deploy.trigger` (Stage and every other build) lives in
 * deploy-trigger.ts: it holds no transaction while it builds (#1211).
 * Publish live (`deploy.promote`) still builds and publishes inside one
 * transaction; its run row is committed on its own (deploy.begin_run) so
 * the Ops dashboard shows it and its progress while it runs.
 */

import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  type DatabaseAdapter,
  defineOperation,
  execute,
  type OperationRegistry,
  type TransactionRunner,
} from "@caelo-cms/query-api";
import { CAELO_VERSION, type ExecutionContext, err, ok, PhaseTimer } from "@caelo-cms/shared";
import { type DeployTarget, readSeoSettings } from "@caelo-cms/static-generator";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { describeError } from "../ai/tools/_describe-error.js";
import { buildDirOf, removeUploadedBuild, retainedBuildsFor } from "../deploy/build-cleanup.js";
import { buildManifestOf, compareBuildManifests, parityRefusal } from "../deploy/build-parity.js";
import { holdDeployRun } from "../deploy/deploy-run-lock.js";
import {
  resolveGeneratorCli,
  runGenerator,
  systemContextOf,
} from "../deploy/generator-subprocess.js";
import { lockLiveReleases } from "../deploy/live-release-lock.js";
import { resolveOutputRoot } from "../deploy/output-root.js";
import {
  activePluginProblems,
  describePluginProblems,
  stagedWithoutPlugins,
} from "../deploy/plugin-problems.js";
import { syncRedirectsInTx } from "../deploy/redirect-sync.js";
import {
  lockStagingPublication,
  StagingPublicationBusyError,
  tryLockStagingPublication,
} from "../deploy/staging-publication-lock.js";
import {
  loadStaticPublisher,
  type PublishSummary,
  type StaticPublisher,
} from "../deploy/static-publisher.js";
import { forgetAllBakes, rewindBakesToRun } from "../plugin-data/stale-pages.js";
import { jsonbParam } from "../sql-helpers.js";
import { deployRunStartedAt, stampFirstPublished } from "./content/first-published.js";
import {
  effectiveOutDir,
  logRunTimings,
  phaseTimingsParam,
  productionNeedsHuman,
  rowToTarget,
  runStartedAt,
  selectServedStagingPreview,
  type TargetDbRow,
  targetRow,
} from "./deploy-common.js";
import { json } from "./quality/_shared.js";
import { publishGateForRun } from "./quality/gate-loader.js";

export { effectiveOutDir } from "./deploy-common.js";
export { triggerDeployOp } from "./deploy-trigger.js";

/**
 * Absolute path of a run's build archive (`<outDir>/builds/<runId>`) as
 * deploy.trigger wrote it on THIS process — the #553 audit serves it when
 * the provider has no reachable staging origin.
 */
export function localBuildArchiveDir(args: {
  provider: string | undefined;
  env: string;
  outDir: string;
  runId: string;
}): string {
  return resolve(
    resolveOutputRoot(),
    effectiveOutDir(args.provider, args.env, args.outDir),
    "builds",
    args.runId,
  );
}

const runRow = z.object({
  id: z.string(),
  targetId: z.string(),
  targetName: z.string(),
  env: z.enum(["dev", "staging", "production"]),
  actorId: z.string(),
  status: z.enum(["pending", "running", "succeeded", "failed"]),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  pageCount: z.number().int().nullable(),
  fileCount: z.number().int().nullable(),
  errorMessage: z.string().nullable(),
  buildId: z.string().nullable(),
  progress: z.object({ pagesDone: z.number().int(), pagesTotal: z.number().int() }).nullable(),
  /**
   * #1155 — `site`: a build of the site (Stage, Publish live, a production
   * build, a rollback); `plugin_data`: the live build republished with
   * fresher plugin data only. A `plugin_data` run makes nothing else live,
   * so "when did a human last publish" skips it.
   */
  buildKind: z.enum(["site", "plugin_data"]),
});

interface RunDbRow {
  id: string;
  target_id: string;
  target_name: string;
  env: "dev" | "staging" | "production";
  actor_id: string;
  status: "pending" | "running" | "succeeded" | "failed";
  started_at: string | Date;
  finished_at: string | Date | null;
  page_count: number | string | null;
  file_count: number | string | null;
  error_message: string | null;
  build_id: string | null;
  progress: { pagesDone: number; pagesTotal: number } | string | null;
  build_kind: "site" | "plugin_data";
}

function rowToRun(r: RunDbRow): z.infer<typeof runRow> {
  const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : String(v));
  const num = (v: number | string | null) =>
    v === null ? null : typeof v === "string" ? Number.parseInt(v, 10) : v;
  let progress: { pagesDone: number; pagesTotal: number } | null = null;
  if (r.progress !== null) {
    progress = typeof r.progress === "string" ? JSON.parse(r.progress) : r.progress;
  }
  return {
    id: r.id,
    targetId: r.target_id,
    targetName: r.target_name,
    env: r.env,
    actorId: r.actor_id,
    status: r.status,
    startedAt: iso(r.started_at),
    finishedAt: r.finished_at === null ? null : iso(r.finished_at),
    pageCount: num(r.page_count),
    fileCount: num(r.file_count),
    errorMessage: r.error_message,
    buildId: r.build_id,
    progress,
    buildKind: r.build_kind,
  };
}

export const listDeployTargetsOp = defineOperation({
  name: "deploy.list_targets",
  // CLAUDE.md §11: AI summarises deploy state when the user asks
  // ("which environments are configured?"). Read-only.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({}),
  output: z.object({ targets: z.array(targetRow) }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, name, env, out_dir, base_url, robots_default, is_default, page_url_style
      FROM deploy_targets
      ORDER BY env ASC, name ASC
    `)) as unknown as TargetDbRow[];
    return ok({ targets: rows.map(rowToTarget) });
  },
});

export const listDeployRunsOp = defineOperation({
  name: "deploy.list_runs",
  // CLAUDE.md §11: AI inspects deploy history when troubleshooting
  // ("did the last build succeed?"). Read-only. Plugin actors read it
  // too (epic #1107): international-site garbage-collects a removed
  // entry's translations only once a production build after the removal
  // succeeded — "the removal is live", so an undo before that restores
  // them.
  actorScope: ["human", "ai", "plugin", "system"],
  database: "cms_admin",
  input: z.object({
    limit: z.number().int().min(1).max(200).default(50),
    /**
     * #1155 — only runs of this kind. Readers of "what a human last staged
     * and published" pass `site`: plugin-data builds run every tick and
     * would otherwise push those runs out of the window.
     */
    buildKind: z.enum(["site", "plugin_data"]).optional(),
  }),
  output: z.object({ runs: z.array(runRow) }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT r.id::text AS id,
             r.target_id::text AS target_id,
             t.name AS target_name,
             t.env AS env,
             r.actor_id::text AS actor_id,
             r.status,
             r.started_at, r.finished_at,
             r.page_count, r.file_count, r.error_message,
             r.build_id, r.progress, r.build_kind
      FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
      ${input.buildKind ? sql`WHERE r.build_kind = ${input.buildKind}` : sql``}
      ORDER BY r.started_at DESC
      LIMIT ${input.limit}
    `)) as unknown as RunDbRow[];
    return ok({ runs: rows.map(rowToRun) });
  },
});

export const getDeployRunOp = defineOperation({
  name: "deploy.get_run",
  // CLAUDE.md §11: read-only. #1211 — a Stage that outlasts the caller's
  // wait keeps building; the AI reads its run to learn how far it got.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ runId: z.string().uuid() }).strict(),
  output: z.object({ run: runRow.nullable() }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT r.id::text AS id,
             r.target_id::text AS target_id,
             t.name AS target_name,
             t.env AS env,
             r.actor_id::text AS actor_id,
             r.status,
             r.started_at, r.finished_at,
             r.page_count, r.file_count, r.error_message,
             r.build_id, r.progress, r.build_kind
      FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
      WHERE r.id = ${input.runId}::uuid
    `)) as unknown as RunDbRow[];
    const row = rows[0];
    return ok({ run: row ? rowToRun(row) : null });
  },
});

export const updateDeployProgressOp = defineOperation({
  name: "deploy.update_progress",
  // Why human-only: system internal callback; only the static-generator subprocess writes to it.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      runId: z.string().uuid(),
      pagesDone: z.number().int().nonnegative(),
      pagesTotal: z.number().int().nonnegative(),
    })
    .strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE deploy_runs
      SET progress = ${jsonbParam({ pagesDone: input.pagesDone, pagesTotal: input.pagesTotal })}
      WHERE id = ${input.runId}::uuid
    `);
    return ok({});
  },
});

/**
 * P6.2 promote ("Publish live") — ship the source target's
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
 */
// FIXME(issue #1225): Publish live still rebuilds and uploads inside this
// one transaction (and takes nested checkouts for begin_run / progress);
// it moves to the step-wise shape deploy.trigger has (#1211).
export const promoteDeployOp = defineOperation({
  name: "deploy.promote",
  // Why human-only: Ops-level decision per CMS_REQUIREMENTS §6 (staging → production gate).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({
    fromTarget: z.string(),
    toTarget: z.string(),
    repoRoot: z.string().optional(),
  }),
  output: z.object({
    fromRunId: z.string(),
    toRunId: z.string(),
    buildId: z.string(),
  }),
  handler: async (ctx, input, tx) => {
    const startedAt = await runStartedAt(tx);
    const timer = new PhaseTimer();
    if (input.fromTarget === input.toTarget) {
      return err({
        kind: "HandlerError",
        operation: "deploy.promote",
        message: "fromTarget and toTarget must differ",
      });
    }
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, name, env, out_dir, base_url, robots_default, is_default, page_url_style
      FROM deploy_targets
      WHERE name IN (${input.fromTarget}, ${input.toTarget})
    `)) as unknown as TargetDbRow[];
    const from = rows.find((r) => r.name === input.fromTarget);
    const to = rows.find((r) => r.name === input.toTarget);
    if (!from || !to) {
      return err({
        kind: "HandlerError",
        operation: "deploy.promote",
        message: "fromTarget or toTarget not found",
      });
    }
    const fromRunRows = (await tx.execute(sql`
      SELECT id::text AS id, build_id, site_url,
             plugin_problems
      FROM deploy_runs
      WHERE target_id = ${from.id}::uuid AND status = 'succeeded' AND build_id IS NOT NULL
      ORDER BY started_at DESC LIMIT 1
    `)) as unknown as {
      id: string;
      build_id: string | null;
      site_url: string | null;
      plugin_problems: unknown;
    }[];
    const fromRow = fromRunRows[0];
    const fromRunId = fromRow?.id;
    const buildId = fromRow?.build_id;
    if (!fromRunId || !buildId) {
      // run #10 D6 — AI/operator-actionable failure surface (CLAUDE.md
      // §11): name the next step instead of just the diagnosis.
      return err({
        kind: "HandlerError",
        operation: "deploy.promote",
        message: `no succeeded build to promote from '${from.name}' — run Stage first (deploy.trigger targetName=${from.name}); Publish live only copies an already-staged build`,
      });
    }
    // #1154 — Publish live is a human's click (the toolbar, the pages list,
    // Ops, or an approved propose_deploy_promote applied as the approver).
    const automatic = productionNeedsHuman(ctx, to.env, "deploy.promote");
    if (automatic) return err(automatic);

    // #1008 — never publish a site without an active plugin: not while one
    // is not running, and not a Stage that was built while one was not
    // (it lacks that plugin's output even after the plugin recovered).
    if (to.env === "production") {
      const stale = stagedWithoutPlugins(fromRow?.plugin_problems);
      if (stale) return err({ kind: "HandlerError", operation: "deploy.promote", message: stale });
      const problems = await activePluginProblems(tx);
      if (problems.length > 0) {
        return err({
          kind: "HandlerError",
          operation: "deploy.promote",
          message: describePluginProblems(problems),
        });
      }
    }

    // #553 — the quality gate. Every Publish-live path runs this handler
    // (the toolbar, the pages list, Ops, and the approved propose_deploy_promote,
    // which calls the handler directly), so the gate lives here and nowhere
    // else. Only staging builds are audited, so only they are gated.
    if (from.env === "staging") {
      const gate = await publishGateForRun(tx, fromRunId);
      if (!gate.open) {
        return err({
          kind: "HandlerError",
          operation: "deploy.promote",
          message: gate.message,
        });
      }
    }

    const root = resolveOutputRoot(input.repoRoot);
    const fromBuildDir = resolve(root, from.out_dir, "builds", buildId);
    const fromTarget = rowToTarget(from);
    const toTarget = rowToTarget(to);

    const bridge = getDeployBridge();
    if (!bridge) {
      await tx.execute(sql`
        INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at, error_message)
        VALUES (${to.id}::uuid, ${ctx.actorId}::uuid, 'failed', ${startedAt}::timestamptz,
                clock_timestamp(), 'deploy-bridge not configured')
      `);
      return err({
        kind: "HandlerError",
        operation: "deploy.promote",
        message: "deploy-bridge not configured",
      });
    }
    // #1003 — committed now, like a Stage's run (see deploy.trigger): the
    // deployments page shows the running Publish live and its rebuild's
    // progress; the lock marks it as still building until this transaction ends.
    const toRunId = randomUUID();
    await holdDeployRun(tx, toRunId);
    const begun = await execute(
      bridge.registry,
      bridge.adapter,
      systemContextOf(ctx),
      "deploy.begin_run",
      {
        runId: toRunId,
        targetId: to.id,
        actorId: ctx.actorId,
        startedAt,
        renderFingerprint: null,
        // Set when the run finishes: a rebuild is rendered by this version,
        // a copy keeps the version of the build it copies.
        caeloVersion: null,
        // The plugin check belongs to the Stage it promotes, not to this run.
        pluginProblems: null,
      },
    );
    if (!begun.ok) {
      return err({
        kind: "HandlerError",
        operation: "deploy.promote",
        message: `could not start the deploy run: ${describeError(begun.error)}`,
      });
    }
    timer.lap("prepare");
    try {
      // v0.2.78 — delegate to the per-provider StaticPublisher.
      // Self-hosted does the existing copyTreeExcept + syncContents
      // overlay; cloud does cross-bucket server-side object copies.
      // A CDN purge must not re-release the old live version mid-publish.
      await lockLiveReleases(tx);
      // #650 — and no Stage may publish or prune previews until this
      // publish has decided what staging serves next (lock order: live
      // release first, see staging-publication-lock.ts). A Stage that is
      // publishing right now finishes first (#1211: it holds the lease).
      if (fromRow?.site_url) await lockStagingPublication(tx);
      timer.lap("lock-wait");
      const provider = process.env.CAELO_PROVIDER;
      const publisher = await loadStaticPublisher(provider);
      if (fromRow?.site_url) {
        // staging.<domain> keeps serving what it serves — the build about
        // to go live, or a newer Stage — so after the release it shows the
        // published state instead of "nothing staged". Re-selecting it keeps
        // its preview alive even when it was staged before served previews
        // stopped expiring, and sweeps up previews a failed retirement left.
        // Done before the release, so a failure publishes nothing.
        await selectServedStagingPreview(publisher, await servedStagingRun(tx));
        timer.lap("select-preview");
      }
      const { siteBaseUrl } = await readSeoSettings(tx);
      // #650 — a build staged with its own staging host cannot be copied
      // live (every absolute URL names staging.<domain>): rebuild the same
      // content with the live host, prove it differs only in the host, and
      // publish the rebuild. A build staged with the live host (providers
      // without a staging domain, or staged before the switch) is copied
      // as before.
      const rebuilt = fromRow?.site_url
        ? await rebuildAndPublishLive(ctx, tx, {
            publisher,
            provider,
            stagingRunId: fromRunId,
            toRunId,
            toTarget: to,
            repoRoot: root,
            timer,
          })
        : null;
      const { phases: copyPhases, ...summary } =
        rebuilt?.summary ??
        (await publisher.promoteToProduction({
          sourceRunId: buildId,
          sourceBuildDir: fromBuildDir,
          fromTarget,
          toTarget,
          siteBaseUrl,
        }));
      if (!rebuilt) {
        timer.include("publish", copyPhases ?? []);
        timer.lap("publish");
      }
      // Epic #1107 — Publish live: the pages of the build it ships get
      // their first_published_at — the staged run's start, which is what
      // both the staged build and its live rebuild rendered.
      if (to.env === "production") {
        await stampFirstPublished(tx, fromRunId);
        // #1155 — the promoted build baked its plugin data when it was
        // staged; bakes a plugin-data build made since are pending again.
        await rewindBakesToRun(tx, fromRunId);
      }
      timer.lap("finish");
      await tx.execute(sql`
        UPDATE deploy_runs
        SET status = 'succeeded', finished_at = clock_timestamp(),
            phase_timings = ${phaseTimingsParam(timer)},
            page_count = ${rebuilt ? rebuilt.pageCount : sql`(SELECT page_count FROM deploy_runs WHERE id = ${fromRunId}::uuid)`},
            file_count = ${rebuilt ? rebuilt.fileCount : sql`(SELECT file_count FROM deploy_runs WHERE id = ${fromRunId}::uuid)`},
            build_id = ${summary.destinationBuildId},
            publish_summary = ${jsonbParam(summary)},
            site_url = ${rebuilt ? siteBaseUrl : null},
            -- #834 — a rebuild is rendered by this version; a copy keeps
            -- the version that rendered the copied build.
            caelo_version = ${rebuilt ? CAELO_VERSION : sql`(SELECT caelo_version FROM deploy_runs WHERE id = ${fromRunId}::uuid)`}
        WHERE id = ${toRunId}::uuid
      `);
      // #1157 — the build carries the redirects table as it was at its
      // Stage; redirects saved since then are already live and must stay
      // so, and rows a page of this build now serves must step aside. A
      // provider failure here does not fail the publish (the files are
      // live): it is recorded, shown in Settings → Redirects and retried.
      await syncRedirectsInTx(tx, ctx, {
        trigger: "publish",
        targetIds: [to.id],
        outputRoot: root,
      });
      // Last fallible step done: one line per run, never succeeded + failed.
      logRunTimings("publish-live", toRunId, timer, { status: "succeeded" });
      return ok({ fromRunId, toRunId, buildId: summary.destinationBuildId });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      timer.lap("failed-step");
      await tx.execute(sql`
        UPDATE deploy_runs
        SET status = 'failed', finished_at = clock_timestamp(), error_message = ${message},
            phase_timings = ${phaseTimingsParam(timer)}
        WHERE id = ${toRunId}::uuid
      `);
      logRunTimings("publish-live", toRunId, timer, { status: "failed" });
      return err({
        kind: "HandlerError",
        operation: "deploy.promote",
        // The parity guard's refusal already says what happened and what to
        // do next; anything else is an unexpected publish failure.
        message:
          e instanceof ParityRefusalError || e instanceof StagingPublicationBusyError
            ? message
            : `promotion failed: ${message}`,
      });
    }
  },
});

/** #650 — the live rebuild differs from the staged build in more than the host. */
class ParityRefusalError extends Error {
  override readonly name = "ParityRefusalError";
}

/**
 * #650 — Publish live for a build staged with its own staging host:
 * rebuild main with the live host into the production run (without
 * touching what is served), compare it file by file with the staged
 * build's host-normalised manifest, and only on an exact match hand it to
 * the publisher to go live. Throws {@link ParityRefusalError} naming the
 * differing files otherwise.
 */
async function rebuildAndPublishLive(
  ctx: ExecutionContext,
  tx: Parameters<Parameters<typeof defineOperation>[0]["handler"]>[2],
  args: {
    publisher: StaticPublisher;
    provider: string | undefined;
    stagingRunId: string;
    toRunId: string;
    toTarget: TargetDbRow;
    repoRoot: string;
    /** Laps `generator`, `parity` and `publish` (with their own steps). */
    timer: PhaseTimer;
  },
): Promise<{
  summary: Awaited<ReturnType<NonNullable<StaticPublisher["publishLiveBuild"]>>>;
  pageCount: number;
  fileCount: number;
}> {
  const publishLiveBuild = args.publisher.publishLiveBuild;
  if (!publishLiveBuild) {
    throw new Error(
      `staged build ${args.stagingRunId} was rendered for a separate staging host, but the ${args.provider ?? "self-hosted"} publisher cannot publish a rebuilt tree. Stage again so the build carries the live host.`,
    );
  }
  const manifestRows = (await tx.execute(sql`
    SELECT parity_manifest, caelo_version FROM deploy_runs WHERE id = ${args.stagingRunId}::uuid
  `)) as unknown as {
    parity_manifest: Record<string, string> | string | null;
    caelo_version: string | null;
  }[];
  const raw = manifestRows[0]?.parity_manifest ?? null;
  // NULL = staged before 0287 recorded versions; the refusal says so.
  const stagedCaeloVersion = manifestRows[0]?.caelo_version ?? null;
  if (raw === null) {
    throw new Error(
      `staged build ${args.stagingRunId} has no parity manifest, so Publish live cannot prove the live build matches it. Stage again, then Publish live.`,
    );
  }
  const stagedManifest = json<Record<string, string>>(raw);

  const bridge = getDeployBridge();
  if (!bridge) throw new Error("deploy-bridge not configured");
  const target: DeployTarget = {
    ...rowToTarget(args.toTarget),
    outDir: effectiveOutDir(args.provider, args.toTarget.env, args.toTarget.out_dir),
  };
  // #1211 — every way out deletes what the generator wrote, a failed or
  // refused rebuild included: with `retainBuilds: 0` nothing else prunes
  // it, and on Cloud Run `/tmp` is memory.
  const buildDir = buildDirOf(args.repoRoot, target.outDir, args.toRunId);
  try {
    const built = await runGenerator(bridge.registry, bridge.adapter, ctx, {
      cliPath: resolveGeneratorCli(),
      runId: args.toRunId,
      target,
      repoRoot: args.repoRoot,
      // The staged build's instant: the parity guard compares the two
      // renders, and Publish live stores this value (#1121 review).
      publishAt: await deployRunStartedAt(tx, args.stagingRunId),
      // Nothing may serve this build before the parity guard passed.
      syncCurrent: false,
      // #1211 — an uploading publisher keeps no builds in the container.
      retainBuilds: retainedBuildsFor(args.publisher),
    });
    if (built.ok) args.timer.include("generator", built.result.phases);
    args.timer.lap("generator");
    if (!built.ok) {
      const tail = built.stderr ? ` — ${built.stderr.slice(-300).trim()}` : "";
      throw new Error(`the live rebuild failed: ${built.message}${tail}`);
    }
    const diff = compareBuildManifests(
      stagedManifest,
      await buildManifestOf(built.result.buildDir),
    );
    const refusal = parityRefusal(diff, {
      stagingRunId: args.stagingRunId,
      stagedCaeloVersion,
      runningCaeloVersion: CAELO_VERSION,
    });
    args.timer.lap("parity");
    if (refusal) throw new ParityRefusalError(refusal);

    const summary = await publishLiveBuild({
      buildDir: built.result.buildDir,
      runId: args.toRunId,
      target,
      sourceRunId: args.stagingRunId,
    });
    args.timer.include("publish", summary.phases ?? []);
    args.timer.lap("publish");
    return { summary, pageCount: built.result.pageCount, fileCount: built.result.fileCount };
  } finally {
    // Uploaded, refused or failed: the provider holds what goes live, not /tmp.
    await removeUploadedBuild(args.publisher, buildDir);
  }
}

/**
 * #650 — the run staging serves, or null when nothing was ever staged. Read
 * under the staging-publication lock, so the answer holds until commit.
 */
async function servedStagingRun(tx: TransactionRunner): Promise<string | null> {
  const rows = (await tx.execute(sql`
    SELECT origin_run_id::text AS run_id FROM staging_access WHERE id = 1
  `)) as unknown as { run_id: string | null }[];
  return rows[0]?.run_id ?? null;
}

/**
 * #969 — keep the preview staging serves alive between Stages. A provider
 * whose served preview has a finite lifetime (Firebase Hosting: preview
 * channels live at most 30 days and cannot be made permanent) extends it
 * again; Stage and Publish live do the same through selectStagingPreview,
 * this covers the idle stretch in between. Runs under the staging
 * publication lock, so it refreshes exactly the preview a concurrent
 * Publish live leaves served. While a Stage holds the lease (#1211) the
 * tick is skipped: that Stage selects — and so refreshes — the preview
 * staging serves next itself. A served preview that is already gone fails
 * loudly (Stage again) — never a silent no-op.
 */
export const refreshStagingPreviewOp = defineOperation({
  name: "deploy.refresh_staging_preview",
  // Why human-only: a maintenance tick the keep-alive worker runs on a
  // timer; it decides nothing an editor or the AI chooses (Stage already
  // refreshes the preview), so it carries no AI tool.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({}).strict(),
  output: z.object({
    servedRunId: z.string().nullable(),
    expiresAt: z.string().nullable(),
  }),
  handler: async (_ctx, _input, tx) => {
    const publisher = await loadStaticPublisher(process.env.CAELO_PROVIDER);
    if (!publisher.refreshStagingPreview) return ok({ servedRunId: null, expiresAt: null });
    if (!(await tryLockStagingPublication(tx)).locked) {
      return ok({ servedRunId: null, expiresAt: null });
    }
    const servedRunId = await servedStagingRun(tx);
    if (servedRunId === null) return ok({ servedRunId: null, expiresAt: null });
    try {
      const { expiresAt } = await publisher.refreshStagingPreview({ servedRunId });
      return ok({ servedRunId, expiresAt });
    } catch (e) {
      return err({
        kind: "HandlerError",
        operation: "deploy.refresh_staging_preview",
        message: `the staging preview of build ${servedRunId} could not be kept alive: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  },
});

/**
 * Rollback: re-target a target's `current` symlink at any prior
 * succeeded build for that target. Atomic, no rebuild. The caller
 * passes the deploy_runs.id whose `build_id` should become live.
 */
export const rollbackDeployOp = defineOperation({
  name: "deploy.rollback",
  // Why human-only: Ops-level decision per CMS_REQUIREMENTS §6.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      targetName: z.string(),
      runId: z.string().uuid(),
      repoRoot: z.string().optional(),
    })
    .strict(),
  output: z.object({ buildId: z.string(), newRunId: z.string() }),
  handler: async (ctx, input, tx) => {
    const startedAt = await runStartedAt(tx);
    const targetRows = (await tx.execute(sql`
      SELECT id::text AS id, name, env, out_dir, base_url, robots_default, is_default, page_url_style
      FROM deploy_targets WHERE name = ${input.targetName} LIMIT 1
    `)) as unknown as TargetDbRow[];
    const target = targetRows[0];
    if (!target) {
      return err({
        kind: "HandlerError",
        operation: "deploy.rollback",
        message: `target not found: ${input.targetName}`,
      });
    }
    const priorRows = (await tx.execute(sql`
      SELECT build_id, publish_summary->>'location' AS location, caelo_version FROM deploy_runs
      WHERE id = ${input.runId}::uuid
        AND target_id = ${target.id}::uuid
        AND status = 'succeeded'
        AND build_id IS NOT NULL
      LIMIT 1
    `)) as unknown as { build_id: string; location: string | null; caelo_version: string | null }[];
    const buildId = priorRows[0]?.build_id;
    if (!buildId) {
      return err({
        kind: "HandlerError",
        operation: "deploy.rollback",
        message: "no matching succeeded build for that target",
      });
    }
    const root = resolveOutputRoot(input.repoRoot);
    const outDir = resolve(root, target.out_dir);
    const buildDir = join(outDir, "builds", buildId);
    let summary: PublishSummary;
    try {
      // v0.2.78 — delegate to the per-provider StaticPublisher.
      // A CDN purge must not re-release the old live version mid-rollback.
      await lockLiveReleases(tx);
      const provider = process.env.CAELO_PROVIDER;
      const publisher = await loadStaticPublisher(provider);
      const { siteBaseUrl } = await readSeoSettings(tx);
      summary = await publisher.rollback({
        targetBuildId: buildId,
        sourceBuildDir: buildDir,
        target: rowToTarget(target),
        siteBaseUrl,
        sourceLocation: priorRows[0]?.location ?? null,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err({
        kind: "HandlerError",
        operation: "deploy.rollback",
        message: `rollback failed: ${message}`,
      });
    }
    // The summary names where the rolled-back release now lives (Firebase:
    // the Hosting version the rollback created). Recording it makes this
    // run itself a valid rollback source later — without it the Firebase
    // publisher refuses a run with no `publish_summary.location`.
    // #1155 — and the Caelo version that rendered the restored build: it
    // is what is live now, and a plugin-data build refreshes regions only
    // while the running version rendered the live build.
    const newRunRows = (await tx.execute(sql`
      INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at, build_id,
                               publish_summary, caelo_version)
      VALUES (${target.id}::uuid, ${ctx.actorId}::uuid, 'succeeded', ${startedAt}::timestamptz,
              clock_timestamp(), ${buildId}, ${jsonbParam(summary)},
              ${priorRows[0]?.caelo_version ?? null})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const newRunId = newRunRows[0]?.id ?? "";
    // #1157 — the rolled-back build carries the redirects of its own time;
    // the provider must serve the table as it is now.
    await syncRedirectsInTx(tx, ctx, {
      trigger: "rollback",
      targetIds: [target.id],
      outputRoot: root,
    });
    // #1155 — the build put back may lack any bake made since it ran.
    if (target.env === "production") await forgetAllBakes(tx);
    return ok({ buildId, newRunId });
  },
});

// ─── Deploy bridge ────────────────────────────────────────────────────
// The trigger op needs a registry+adapter pair to write progress rows
// from inside its subprocess-watching loop. The host process registers
// them via setDeployBridge() at startup; tests do the same in beforeAll.
// This is a small concession to the layered model — without it we'd
// need to thread the registry through every defineOperation call.

interface DeployBridge {
  registry: OperationRegistry;
  adapter: DatabaseAdapter;
}
let bridge: DeployBridge | null = null;

/** Attach the registry + adapter the trigger op reports progress through; `null` detaches it. */
export function setDeployBridge(b: DeployBridge | null): void {
  bridge = b;
}
export function getDeployBridge(): DeployBridge | null {
  return bridge;
}
