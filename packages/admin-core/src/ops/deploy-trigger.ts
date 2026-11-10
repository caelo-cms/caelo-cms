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
 *   deploy.acquire_staging_publication  (a Stage: before the upload opens,
 *                          #1330 — the upload fills the staging slot staging
 *                          does not serve, and no other Stage may fill it too)
 *   (publisher upload)     no transaction
 *   deploy.finish_trigger  record the origin + the run, release the lease;
 *                          a production build releases the Staged redirect
 *                          changes it serves (#1550) and marks the live
 *                          redirects behind; a staging build writes the
 *                          quality audit row deploy.start_trigger planned
 *                          (#1319) in this same transaction, so no
 *                          succeeded Stage is ever left without its audit
 *   redirects.sync_provider production only: push the live redirects
 *                          (provider I/O, after the run is recorded; a
 *                          failure is retried). Staging is pushed nothing:
 *                          the staging gateway serves the staging view
 *                          itself (#1330, #1550)
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
  freezeRelease,
  pointLiveRelease,
  pointStagingRelease,
  ReleaseFreezeError,
} from "@caelo-cms/migrations/public-projection";
import { pluginHostBootstrapped } from "@caelo-cms/plugin-host";
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
  siteHeaderSetSchema,
} from "@caelo-cms/shared";
import type { DeployTarget } from "@caelo-cms/static-generator";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { describeError } from "../ai/tools/_describe-error.js";
import {
  buildDirOf,
  mediaDeliveryFor,
  removeUploadedBuild,
  retainedBuildsFor,
} from "../deploy/build-cleanup.js";
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
import { describeRenderFailures } from "../deploy/render-failures.js";
import { liveSiteOrigin, readStagingHost, stagingGateSecret } from "../deploy/staging-domain.js";
import {
  releaseStagingPublication,
  STAGING_PUBLICATION_WAIT_MS,
} from "../deploy/staging-publication-lock.js";
import {
  type BuildUpload,
  loadStaticPublisher,
  type StaticPublisher,
} from "../deploy/static-publisher.js";
import { truncatedListSchema } from "../deploy/truncated-lists.js";
import { unpublishedLinkTargetSchema } from "../deploy/unpublished-links.js";
import {
  STAGING_GATEWAY_URL_ENV,
  verifyStagedBuildServed,
  verifyStagingGatewayServes,
} from "../deploy/verify-staged-serve.js";
import {
  type LinkNotice,
  linkNoticeSchema,
  linksTheCheckMissed,
  withBuiltLinks,
} from "../links/link-notice.js";
import { loadedVisitorProjections } from "../public-projection.js";
import { kickQualityAuditWorker } from "../quality/audit-worker.js";
import { loadStagedChanges } from "../redirects/model.js";
import {
  releaseRedirectChanges,
  takeOverRedirectsOnFirstPublishedPages,
} from "../redirects/release.js";
import { jsonbParam } from "../sql-helpers.js";
import { clearStagingInbox, loadedInboxTables } from "../stage/staging-inbox.js";
import { deployRunStartedAt, stampFirstPublished } from "./content/first-published.js";
import { buildReferenceGate } from "./content/link-integrity.js";

import {
  effectiveOutDir,
  logRunTimings,
  productionNeedsHuman,
  rowToTarget,
  runStartedAt,
  TARGET_COLUMNS,
  type TargetDbRow,
  targetRow,
} from "./deploy-common.js";
import { acquireLeaseStep } from "./deploy-lease-steps.js";
import { beginRunInTx } from "./deploy-run-lifecycle.js";
import { digestUndigestedMedia } from "./media_digests.js";
import {
  insertPlannedAudit,
  plannedAuditSchema,
  planStagingAudit,
  type StagingAuditRequest,
  stagingAuditRequestSchema,
} from "./quality/lifecycle.js";
import {
  checkProductionBuildGate,
  type ProductionOverride,
  recordProductionOverride,
} from "./quality/production-gate.js";
import { computeRenderFingerprint } from "./quality/render-fingerprint.js";
import type { RedirectReleasePlan } from "./redirects_release.js";
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
  /**
   * #1319 — the Stage this staging build's quality audit belongs to (the
   * chat, its pre-merge classification, who staged it, or the pages a
   * Stage outside a chat staged on purpose). Omitted = a staging build
   * outside a chat with no particular pages (Ops → Deploy,
   * deploy_staging). Every staging build is audited; the audit row is
   * written in the transaction that records the build as succeeded.
   * Only for staging targets.
   */
  qualityAudit: stagingAuditRequestSchema.optional(),
});

/** The audit request a staging build without an explicit one records. */
const OUTSIDE_CHAT_AUDIT: StagingAuditRequest = {
  chatSessionId: null,
  branch: null,
  pageIds: [],
  stagedBy: null,
};

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
  /** #724 — the reference check's warnings over what this build rendered. */
  linkWarnings: z.array(z.string()),
  /**
   * #1240 — links on published pages to pages without a version in that
   * language. A Stage warning; recorded on the run, and Publish live
   * refuses this build.
   */
  linkNotice: linkNoticeSchema.nullable(),
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
  /**
   * #1550 — a production build whose Staged redirect changes could not be
   * planned: they stay Staged for the next Publish live, and this says why.
   */
  redirectsNote: z.string().optional(),
});

/** What deploy.start_trigger hands the rest of the run. */
const startPlan = z.object({
  runId: z.string(),
  target: targetRow,
  /** The run's first-publication instant (its committed started_at). */
  publishAt: z.string(),
  /**
   * #1330 — a staging build's origin, the live site's
   * (`site_defaults.site_base_url`): every build renders the live host, and
   * the staging gateway rewrites it to the staging host while it streams.
   * Recorded as the run's `site_url`. Null for other targets.
   */
  buildOrigin: z.string().nullable(),
  pluginProblems: z.array(deployPluginProblem),
  /** #1240 — what the reference check said before this build started. */
  linkWarnings: z.array(z.string()),
  linkNotice: linkNoticeSchema.nullable(),
  /** #553 — the publish-anyway decision a production build carries. */
  override: z.object({ auditRunId: z.string(), reason: z.string() }).nullable(),
  /**
   * #1550 — a production build: the Staged redirect changes at the click
   * (the build's confirmation), by id and revision. The ones whose target
   * the new build serves go live with it; one saved since waits.
   */
  redirectChanges: z.array(z.object({ id: z.string(), revision: z.number().int() })),
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
    if (input.qualityAudit !== undefined && target.env !== "staging") {
      return err({
        kind: "HandlerError",
        operation: "deploy.trigger",
        message: `target "${target.name}" is a ${target.env} target — only staging builds are quality-audited, so qualityAudit applies to staging builds only. Drop it, or build the staging target.`,
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
        return err({
          kind: "HandlerError",
          operation: "deploy.trigger",
          message: missingSeo,
          refusal: true,
        });
      }
    }
    // #1240 — every build, whatever it merged: a page published in the panel
    // leaves a Stage nothing to merge, and a rebuild merges nothing at all, so
    // the merge's gate alone let them reach the generator's render gate.
    let linkWarnings: string[] = [];
    let linkNotice: LinkNotice | null = null;
    if (target.env === "staging" || target.env === "production") {
      const links = await buildReferenceGate(tx, target.env);
      if (!links.ok) {
        await recordBlockedRun(tx, ctx, {
          targetId: target.id,
          startedAt,
          message: `Blocked, links: ${links.message}`,
        });
        return err({
          kind: "HandlerError",
          operation: "deploy.trigger",
          message: links.message,
          refusal: true,
        });
      }
      linkWarnings = links.warnings;
      linkNotice = links.notice;
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
      return err({ kind: "HandlerError", operation: "deploy.trigger", message, refusal: true });
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
        return err({
          kind: "HandlerError",
          operation: "deploy.trigger",
          message: gate.message,
          refusal: true,
        });
      }
      override = gate.override;
    }

    // #1330 — a staging build renders the live host like every build (one
    // build, copied live by Publish live, #1003); the staging gateway
    // rewrites it to the staging host while it serves the build.
    const buildOrigin = target.env === "staging" ? await liveSiteOrigin(tx) : null;

    // #1319 — a staging build's audit is planned now, before anything is
    // built: once the build is visible on staging, writing its audit row
    // must not be able to fail. What the plan needs is checked first.
    const auditRequest =
      target.env === "staging" ? (input.qualityAudit ?? OUTSIDE_CHAT_AUDIT) : null;
    if (auditRequest?.chatSessionId) {
      const chat = (await tx.execute(sql`
        SELECT 1 AS found FROM chat_sessions WHERE id = ${auditRequest.chatSessionId}::uuid
      `)) as unknown as { found: number }[];
      if (chat.length === 0) {
        return err({
          kind: "HandlerError",
          operation: "deploy.trigger",
          message: `chat ${auditRequest.chatSessionId} does not exist, so this Stage's quality check has no chat to report to — nothing was built. Stage from an open chat (or without qualityAudit, outside a chat).`,
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
    if (auditRequest !== null) {
      const planned = await planStagingAudit(tx, { deployRunId: input.runId, ...auditRequest });
      await tx.execute(sql`
        UPDATE deploy_runs SET planned_audit = ${jsonbParam(planned)}
        WHERE id = ${input.runId}::uuid
      `);
    }
    // #1329 — the projection's release sections (the plugin registry and
    // each plugin's published rows) are frozen with the build, as the
    // build reads the site: a Stage shows exactly this state on staging and
    // Publish live releases exactly it; an Owner's production build
    // releases it at once.
    if (target.env === "staging" || target.env === "production") {
      try {
        await freezeRelease(tx, {
          runId: input.runId,
          reason: target.env === "staging" ? "stage" : "production-build",
          declarations: loadedVisitorProjections(),
          // A plugin not running here is recorded with the run (#1008) and
          // Publish live refuses the Stage; staging shows it unpublished.
          completeness: "as-loaded",
        });
      } catch (e) {
        if (!(e instanceof ReleaseFreezeError)) throw e;
        throw new OperationAbortError({
          kind: "HandlerError",
          operation: "deploy.trigger",
          message: e.message,
        });
      }
    }
    return ok({
      runId: input.runId,
      target: rowToTarget(target),
      publishAt: await deployRunStartedAt(tx, input.runId),
      buildOrigin,
      pluginProblems,
      linkWarnings,
      linkNotice,
      override,
      redirectChanges:
        target.env === "production"
          ? (await loadStagedChanges(tx)).map((c) => ({ id: c.id, revision: c.revision }))
          : [],
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
      /** #1330 — a Stage's build origin (it held the staging-publication lease); null otherwise. */
      buildOrigin: z.string().nullable(),
      /** #1330 — where a Stage's complete build lies in staging storage; null otherwise. */
      stagingLocation: z.string().nullable(),
      override: z.object({ auditRunId: z.string(), reason: z.string() }).nullable(),
      phaseTimings: z.array(phaseTimingSchema),
      /** #1319 — what the audit log records as the Stage's audit request. */
      qualityAudit: stagingAuditRequestSchema.nullable(),
      /** #1454 — the headers of this build's pages (`security_headers.get` reads them). */
      securityHeaders: siteHeaderSetSchema,
      /** #1240 — the language links this build rendered; null: none. */
      linkNotice: linkNoticeSchema.nullable(),
      /**
       * #1550 — a production build: the Staged redirect changes the new
       * build serves (redirects.release_plan's `goingLive`); empty otherwise.
       */
      redirectChanges: z
        .array(z.object({ id: z.string().uuid(), revision: z.number().int().min(1) }).strict())
        .max(20_000)
        .default([]),
      /** The live table that plan was made against (redirects.release_plan's `liveFingerprint`). */
      redirectLiveFingerprint: z.string().nullable().default(null),
    })
    .strict(),
  output: z.object({
    draftPages: draftPagesSummary,
    /** #1330 — `https://<staging host>/` for a Stage while a host is set; null otherwise. */
    stagingUrl: z.string().nullable(),
    /** #1550 — how many redirect changes a production build put live. */
    redirectsApplied: z.number().int(),
    /** Why none went live although some were listed (they stay Staged). */
    redirectsHeldBack: z.string().nullable(),
  }),
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
      SELECT planned_audit FROM deploy_runs
      WHERE id = ${input.runId}::uuid AND status = 'running'
      FOR UPDATE
    `)) as unknown as { planned_audit: unknown }[];
    const runRow = running[0];
    if (!runRow) {
      refuse(
        `build ${input.runId} was marked failed while it ran (its heartbeat stopped for longer than the lease); nothing it built is recorded. Stage again.`,
      );
    }
    // deploy.start_trigger planned every staging build's audit; a staging
    // run without one is a bug in this op, never a state to accept.
    const planned =
      input.env === "staging" ? plannedAuditSchema.safeParse(runRow?.planned_audit) : null;
    if (planned && !planned.success) {
      refuse(
        `staging build ${input.runId} has no planned quality check (deploy_runs.planned_audit: ${planned.error.message}), so it is not recorded as staged. Stage again.`,
      );
    }
    if (input.env === "staging") {
      // Released first: this transaction keeps the row locked until it
      // commits, so the redirect sync below sees it free and no other
      // publish gets in between.
      const held = await releaseStagingPublication(tx, input.runId);
      if (held !== true) {
        refuse(
          `staging build ${input.runId} lost its place in the staging publish order (its lease lapsed), so another Stage may have changed what staging serves. Staging keeps serving that; Stage again.`,
        );
      }
      const servedLocation =
        input.stagingLocation ??
        refuse(
          `staging build ${input.runId} was published without a staging location, so the staging gateway would not find it. A Caelo bug; report it with bug_report, then Stage again.`,
        );
      // #1330 — the build staging serves from now on: the drain after this
      // commit points the staging gateway at its complete slot.
      await setStagingOrigin(tx, { servedLocation, runId: input.runId });
    }
    // The publish-anyway decision is recorded only now that the build it
    // allowed is live; a failed build leaves the quality gate closed.
    if (input.override) {
      await recordProductionOverride(tx, ctx, input.override, "deploy.trigger");
    }
    // Epic #1107 — a production build is a Publish live: pages it ships
    // for the first time get their first_published_at.
    // #1517 — and take their URLs over from redirect rules there.
    // #1550 — and the redirect changes it ships go live with it, before
    // the run is stamped finished (a rollback to this run keeps them).
    let redirectsApplied = 0;
    let redirectsHeldBack: string | null = null;
    if (input.env === "production") {
      // All of the plan, or none when a listed change or the live table
      // moved on since it was made.
      if (input.redirectChanges.length > 0) {
        const released =
          input.redirectLiveFingerprint === null
            ? ({ released: false, reason: "they were listed without a plan" } as const)
            : await releaseRedirectChanges(
                tx,
                ctx.actorId,
                input.redirectChanges,
                { kind: "release", runId: input.runId },
                { states: ["staged"], liveFingerprint: input.redirectLiveFingerprint },
              );
        if (released.released) redirectsApplied = released.applied.length;
        else redirectsHeldBack = released.reason;
      }
      await takeOverRedirectsOnFirstPublishedPages(
        ctx,
        tx,
        input.runId,
        await stampFirstPublished(tx, input.runId),
      );
    }
    // #1329 — the environment now serves the projection state this run
    // froze (deploy.start_trigger); the drain after this commit publishes
    // it. Staging moves with every Stage; live only with an Owner's
    // production build, which is a human's release like Publish live.
    if (input.env === "staging") await pointStagingRelease(tx, input.runId);
    if (input.env === "production") {
      await pointLiveRelease(tx, input.runId);
      await tx.execute(sql`
        UPDATE deploy_runs SET projection_run_id = ${input.runId}::uuid WHERE id = ${input.runId}::uuid
      `);
    }
    await tx.execute(sql`
      UPDATE deploy_runs
      SET status = 'succeeded', finished_at = clock_timestamp(),
          phase_timings = ${jsonbParam(input.phaseTimings)},
          page_count = ${input.pageCount},
          file_count = ${input.fileCount},
          build_id = ${input.runId},
          publish_summary = ${jsonbParam(input.publishSummary)},
          site_url = ${input.buildOrigin},
          security_headers = ${jsonbParam(input.securityHeaders)},
          link_notice = ${input.linkNotice === null ? sql`NULL` : jsonbParam(input.linkNotice)},
          lease_expires_at = NULL, planned_audit = NULL
      WHERE id = ${input.runId}::uuid
    `);
    // #1319 — the audit row commits with the build: before, the Stage
    // queued it in a separate call after this commit, and a lost call (pool
    // exhaustion, an admin timeout, a process that died between the two)
    // left a succeeded Stage with no audit and Publish live blocked with
    // nothing to retry. The row was decided before the build
    // (deploy.start_trigger), so this is a plain insert of checked values.
    if (planned?.success) {
      const queued = await insertPlannedAudit(tx, ctx, {
        deployRunId: input.runId,
        planned: planned.data,
        input: { deployRunId: input.runId, ...(input.qualityAudit ?? {}) },
      });
      if (!queued.ok) refuse(describeError(queued.error));
    }
    // #1157 — a production build read the live redirects when it started;
    // the provider must serve them as they are now (this build's changes
    // included). The target is behind until then — pushed after this
    // commit (deploy.trigger), so no provider I/O runs inside this
    // transaction (#1211). #1550 — a Stage needs no push: the staging
    // gateway serves the staging view itself.
    if (input.env === "production") await markRedirectsBehind(tx, [input.targetId]);
    const host = input.env === "staging" ? await readStagingHost(tx) : null;
    return ok({
      draftPages: await mainDraftPages(tx),
      stagingUrl: host ? `https://${host}/` : null,
      redirectsApplied,
      redirectsHeldBack,
    });
  },
});

type TriggerOutput = z.infer<typeof triggerOutput>;

/**
 * #1240 — the reference check and the build disagreed about a link. Filed
 * into the bug intake (#901), because the check exists so that this cannot
 * happen; a failure to file must not change the build's own outcome.
 */
async function reportGateDisagreement(
  steps: OperationSteps,
  sys: ExecutionContext,
  whatHappened: string,
): Promise<void> {
  const r = await execute(steps.registry, steps.adapter, sys, "ai_bug_reports.create", {
    title: "The link check and the build disagreed about a link",
    whatHappened: whatHappened.slice(0, 4000),
    expected:
      "The reference check before a build reports every link the build cannot render, in the same language view.",
    suspectedTool: "deploy.trigger",
    severity: "degraded",
    kind: "defect",
    source: "auto",
  });
  if (!r.ok) console.error("[deploy] could not file the link disagreement", { error: r.error });
}

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
  // #1271 — each step also records the admin's peak RSS while it ran.
  const timer = PhaseTimer.withMemory();
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
  /** #1271 — the provider upload the generator streams the build into. */
  let upload: BuildUpload | null = null;

  /** Record the failure (releasing every lease) and answer with `reply`. */
  const fail = async (
    stored: string,
    reply: string = stored,
    refusal = false,
  ): Promise<Result<TriggerOutput, QueryError>> => {
    const r = await execute(registry, adapter, sys, "deploy.fail_run", {
      runId,
      message: stored,
      phaseTimings: timer.phases(),
    });
    // Unrecorded, the run's lease lapses and the next run marks it failed.
    if (!r.ok) console.error("[deploy] could not record the failed run", { runId, error: r.error });
    // A given-up upload serves nothing (no-op once publishStaging finished it).
    await upload?.abort();
    logRunTimings(runKind, runId, timer, { status: "failed" });
    return err({
      kind: "HandlerError",
      operation: "deploy.trigger",
      message: reply,
      ...(refusal ? { refusal: true as const } : {}),
    });
  };

  try {
    // #1330 — a Stage changes which build staging serves: it takes the
    // staging publish slot before its upload opens, because the upload
    // fills the staging slot staging does NOT serve, and two Stages filling
    // the same slot at once would mix their files. The served location is
    // read with the lease held; nobody changes it until this run releases it.
    let servedStagingLocation: string | null = null;
    if (plan.target.env === "staging") {
      const slot = await acquireLeaseStep<{
        acquired: boolean;
        heldByRunId: string | null;
        servedLocation: string | null;
      }>(steps, sys, {
        op: "deploy.acquire_staging_publication",
        runId,
        ttlMs,
        stop,
        waitMs: STAGING_PUBLICATION_WAIT_MS,
        what: "staging publish slot",
        busyMessage: (heldBy) =>
          `${heldBy ? `another Stage (build ${heldBy})` : "another Stage"} kept publishing the staging site for ${Math.round(STAGING_PUBLICATION_WAIT_MS / 60_000)} minutes, so this build was not started. Stage again once it finished (Settings → Deployments shows it).`,
      });
      timer.lap("lock-wait");
      if (!slot.ok) return await fail(slot.message);
      heartbeat.expectPublication(true);
      servedStagingLocation = slot.value.servedLocation;
    }
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
    // #1271 — the build names media by their stored digests and never
    // reads them. Rows still without digests (written before migration
    // 0452, or by the previous release during an upgrade) get them now,
    // the same way the favicon rendition is made above.
    const digested = await digestUndigestedMedia(registry, adapter, sys);
    if (digested !== null) {
      timer.lap("prepare");
      return await fail(`Blocked, media digests: ${digested}`, digested);
    }
    // Loaded before the build: the publisher decides whether the build is
    // mirrored into `current/` (#1003 — only a serving layer that reads it
    // needs the copy) and whether builds stay on disk (#1211).
    try {
      publisher = await loadStaticPublisher(provider);
      // #1271 — an uploading publisher takes the build file by file while it
      // is written, so it never lands on this container's disk (memory on
      // Cloud Run).
      upload = publisher.openBuildUpload
        ? await publisher.openBuildUpload({ runId, target, servedStagingLocation })
        : null;
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
      syncCurrent: publisher.servesCurrentDir,
      retainBuilds: retainedBuildsFor(publisher),
      mediaDelivery: mediaDeliveryFor(publisher),
      ...(upload ? { upload } : {}),
      signal: stop,
    });
    if (subprocess.ok) timer.include("generator", subprocess.result.phases);
    timer.lap("generator");
    if (!subprocess.ok) {
      // #1240 — a render failure carries its structure: it reaches a person
      // in their words, and a link among them is a Caelo fault.
      if (subprocess.renderFailures && subprocess.renderFailures.length > 0) {
        const text = describeRenderFailures(subprocess.renderFailures);
        if (text.caeloFault) await reportGateDisagreement(steps, sys, text.ai);
        await fail(subprocess.message, text.operator);
        return err({
          kind: "HandlerError",
          operation: "deploy.trigger",
          message: text.operator,
          nextAction: { tool: "check_links", reason: text.ai },
        });
      }
      const tail = subprocess.stderr ? `\n${subprocess.stderr.slice(-500)}` : "";
      // v0.2.77 — the stderr tail rides in the error so the operator's
      // toast carries the real reason, not just "exited 1".
      const stderrTail = subprocess.stderr ? ` — ${subprocess.stderr.slice(-300).trim()}` : "";
      return await fail(
        subprocess.message + tail,
        `generator failed: ${subprocess.message}${stderrTail}`,
        subprocess.refusal === true,
      );
    }
    const built = subprocess.result;
    // #1240 — the build is the truth about its own files: Publish live
    // refuses what it rendered, and a link the check missed is a Caelo bug.
    const missedLinks = linksTheCheckMissed(plan.linkNotice, built.crossVariantLinks);
    const linkNotice = withBuiltLinks(plan.linkNotice, missedLinks);
    if (missedLinks.length > 0) {
      await reportGateDisagreement(
        steps,
        sys,
        `The staging build rendered links the reference check did not report: ${JSON.stringify(missedLinks.slice(0, 10))}`,
      );
    }
    // #1211 — a publisher that serves `current/` (self-hosted) is serving
    // this build already: the generator mirrored it and could not be
    // stopped while it did. A stop from here on cannot unpublish it, so the
    // run is recorded instead of reported as "nothing was published".
    const servedByGenerator = publisher.servesCurrentDir;

    if (stop.aborted && !servedByGenerator) return await fail(abortMessage(stop));

    // #1329 — staging starts from what this Stage publishes: the test
    // inbox (comments, votes, form submissions sent on staging) goes. Part
    // of the Stage's success, and before the build is published: a Stage
    // reported done serves its build from a cleared inbox, and a failure
    // here leaves staging on the previous build.
    if (plan.target.env === "staging") {
      const inbox = loadedInboxTables();
      const stagingDb = pluginHostBootstrapped()?.infra.stagingAdapter;
      if (inbox.length > 0 && !stagingDb) {
        return await fail(
          "the plugin host has no staging database adapter, so the staging inbox could not be cleared and this build was not published. Check PUBLIC_STAGING_ADMIN_DATABASE_URL and the admin's boot log, then Stage again.",
        );
      }
      try {
        if (stagingDb) await clearStagingInbox(stagingDb, inbox);
      } catch (e) {
        return await fail(
          `the staging inbox could not be cleared, so this build was not published: ${e instanceof Error ? e.message : String(e)}. Stage again.`,
        );
      }
      timer.lap("clear-staging-inbox");
    }

    // v0.2.78 — hand off to the per-provider StaticPublisher. Self-hosted
    // is a no-op (the generator already synced into current/); cloud
    // uploads to the staging bucket / preview channel.
    let publishSummary: Record<string, unknown>;
    try {
      const { phases: publishPhases, ...summary } = await publisher.publishStaging({
        buildDir: built.buildDir,
        runId,
        target,
        servedStagingLocation,
        ...(upload ? { upload } : {}),
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
      const gatewayUrl = process.env[STAGING_GATEWAY_URL_ENV];
      const location = publishSummary.stagingLocation;
      // #1330 — an install asks its staging gateway (through the gate, with a
      // per-run check token); a development checkout its local staging port.
      const check =
        gatewayUrl && typeof location === "string"
          ? await verifyStagingGatewayServes({
              gatewayUrl,
              location,
              runId,
              gateSecret: stagingGateSecret(),
            })
          : await verifyStagedBuildServed({ stagingBaseUrl, runId });
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

    // The last point a stop is honoured: from here on the run is recorded.
    if (stop.aborted && !servedByGenerator) return await fail(abortMessage(stop));

    // #1550 — a production build ships the Staged redirect changes of its
    // click whose target it serves; production serves its files now. A
    // plan that cannot be made leaves them Staged (the build is live
    // already): the next Publish live takes them.
    let redirectChanges: { id: string; revision: number }[] = [];
    let redirectFingerprint: string | null = null;
    let redirectNote: string | null = null;
    if (plan.target.env === "production" && plan.redirectChanges.length > 0) {
      const planned = await execute(registry, adapter, sys, "redirects.release_plan", {
        changes: plan.redirectChanges,
        against: "live",
        ...(input.repoRoot ? { repoRoot: input.repoRoot } : {}),
      });
      if (!planned.ok) {
        redirectNote = `The Staged redirect changes stay Staged: ${describeError(planned.error)}`;
      } else {
        const p = planned.value as RedirectReleasePlan;
        if (p.problem !== null)
          redirectNote = `The Staged redirect changes stay Staged: ${p.problem}`;
        redirectChanges = p.goingLive.map((c) => ({ id: c.id, revision: c.revision }));
        redirectFingerprint = p.liveFingerprint;
      }
      if (redirectNote !== null)
        console.error("[deploy] production build", { runId, redirectNote });
    }

    timer.lap("finish");
    const finished = await execute(registry, adapter, ctx, "deploy.finish_trigger", {
      runId,
      targetId: plan.target.id,
      env: plan.target.env,
      pageCount: built.pageCount,
      fileCount: built.fileCount,
      publishSummary,
      buildOrigin: plan.buildOrigin,
      stagingLocation:
        typeof publishSummary.stagingLocation === "string" ? publishSummary.stagingLocation : null,
      override: plan.override,
      phaseTimings: timer.phases(),
      qualityAudit:
        plan.target.env === "staging" ? (input.qualityAudit ?? OUTSIDE_CHAT_AUDIT) : null,
      securityHeaders: built.securityHeaders,
      linkNotice,
      redirectChanges,
      redirectLiveFingerprint: redirectFingerprint,
    });
    if (!finished.ok) return await fail(describeError(finished.error));
    const heldBack = (finished.value as { redirectsHeldBack: string | null }).redirectsHeldBack;
    if (heldBack !== null) {
      redirectNote ??= `The Staged redirect changes stay Staged: ${heldBack}; the next Publish live plans them again.`;
    }
    // The audit row committed with the run; wake this instance's worker
    // instead of waiting for its next pass.
    if (plan.target.env === "staging") kickQualityAuditWorker();
    // The run is recorded; now put the live redirects on the build
    // production serves, in a transaction of its own. A failure is recorded
    // and retried by the redirect-sync worker (the target stays behind).
    // #1550 — staging needs no push: its gateway serves the staging view.
    if (plan.target.env === "production") {
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
      generatorPeakRssMb: built.peakRssMb,
    });

    // #650 / #1330 — staging is shown by its own host, behind the gate.
    const previewUrl = (finished.value as { stagingUrl: string | null }).stagingUrl ?? undefined;
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
      linkWarnings: plan.linkWarnings,
      linkNotice,
      truncatedLists: built.truncatedLists,
      pluginProblems: plan.pluginProblems,
      ...(redirectNote !== null ? { redirectsNote: redirectNote } : {}),
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
    timer.close();
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
