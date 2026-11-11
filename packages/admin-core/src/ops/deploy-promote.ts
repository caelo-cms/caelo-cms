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
 * #1330 — every staged build is rendered for the live host (the staging
 * gateway rewrites it to the staging host while it serves it), so Publish
 * live is a copy on every provider: nothing is rebuilt (#1003). A build an
 * older release staged for a separate staging host cannot be copied live
 * and is refused with "Stage again".
 *
 * #1225 — Publish live holds NO database transaction while it uploads. It is a step-wise op (`defineStepwiseOperation`), like the Stage
 * (deploy-trigger.ts); every database step is a short op of its own:
 *
 *   deploy.start_promote     the gates (targets, a human for production,
 *                            plugins, the quality gate or a publish-anyway
 *                            decision), the run row committed as `running`
 *                            with its lease
 *   redirects.release_plan   #1550 — which Staged redirect changes go live
 *                            with this build: the confirmed ones (or all
 *                            Staged at the click) whose target the build
 *                            serves, read against the build's own files
 *   deploy.acquire_live_release        the live-release lease (waits outside
 *                            any transaction for a rollback or plugin-data
 *                            build that is releasing right now)
 *   (copy)                   no transaction
 *   deploy.renew_run_lease   the fence: proof the run still holds every lease,
 *                            right before the provider release
 *   (provider release)       no transaction
 *   deploy.finish_promote    record the run (the planned redirect changes
 *                            go live, first publication and the redirect
 *                            rules those pages take over, bakes, the
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
 * rebuild (#650, gone with #1330) and upload while its own progress writes took more from the same
 * pool (#1209); an approved card and "publish anyway" ran it inside their
 * own transactions on top of that.
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { hasFrozenRelease, pointLiveRelease } from "@caelo-cms/migrations/public-projection";
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
  PhaseTimer,
  phaseTimingSchema,
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
import { abortMessage, systemContextOf } from "../deploy/generator-subprocess.js";
import { LIVE_RELEASE_WAIT_MS, releaseLiveRelease } from "../deploy/live-release-lock.js";
import { resolveOutputRoot } from "../deploy/output-root.js";
import {
  activePluginProblems,
  describePluginProblems,
  reconcilePluginsForBuild,
  stagedWithoutPlugins,
} from "../deploy/plugin-problems.js";
import { markRedirectsBehind } from "../deploy/redirect-sync.js";
import { loadStaticPublisher, type StaticPublisher } from "../deploy/static-publisher.js";
import { rewindBakesToRun } from "../plugin-data/stale-pages.js";
import {
  releaseRedirectChanges,
  takeOverRedirectsOnFirstPublishedPages,
} from "../redirects/release.js";
import { jsonbParam } from "../sql-helpers.js";
import { stampFirstPublished } from "./content/first-published.js";
import {
  logRunTimings,
  productionNeedsHuman,
  rowToTarget,
  runStartedAt,
  TARGET_COLUMNS,
  type TargetDbRow,
  targetRow,
} from "./deploy-common.js";
import { acquireLeaseStep, fenceRunLeases } from "./deploy-lease-steps.js";
import { beginRunInTx } from "./deploy-run-lifecycle.js";
import { actorHasPermission } from "./quality/_permissions.js";
import { publishGateForRun } from "./quality/gate-loader.js";
import { recordProductionOverride } from "./quality/production-gate.js";
import type { RedirectReleasePlan } from "./redirects_release.js";

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
  /**
   * #1550 — the Staged redirect changes the Publish live confirmation
   * listed as going live (`redirects.release_plan`), by id and revision:
   * exactly these go live, minus any whose target the build does not
   * serve; a change saved after the confirmation waits for the next
   * Publish live. Omitted: the click is the confirmation, every change
   * Staged at that moment.
   */
  redirectChanges: z
    .array(z.object({ id: z.string().uuid(), revision: z.number().int().min(1) }).strict())
    .max(20_000)
    .optional(),
});

/** One change of {@link promoteInput}'s `redirectChanges`. */
const redirectChangeRef = z.object({ id: z.string().uuid(), revision: z.number().int().min(1) });

const promoteOutput = z.object({
  fromRunId: z.string(),
  toRunId: z.string(),
  buildId: z.string(),
  /** #1454 — set when the staged build carries no page headers. */
  securityHeadersNote: z.string().optional(),
  /**
   * #1550 — the redirect changes this Publish live put live, the Staged ones
   * left waiting, and why none went live when a change moved on during it.
   */
  redirects: z.object({
    wentLive: z.number().int(),
    waiting: z.number().int(),
    heldBack: z.string().nullable(),
  }),
});

/** What deploy.start_promote hands the rest of the run. */
const promotePlan = z.object({
  /** #1454 — false for a run staged before the page headers existed. */
  stagedHasSecurityHeaders: z.boolean(),
  toRunId: z.string(),
  from: targetRow,
  to: targetRow,
  /** The staged run being published and its build. */
  fromRunId: z.string(),
  buildId: z.string(),
  /**
   * #1330 — where the staged run's artefact lives remotely
   * (`publish_summary.location`; Firebase: its Hosting version).
   */
  stagedLocation: z.string().nullable(),
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
  // Why site-wide: Publish live ships the whole staged site.
  readScope: "site",
  // Why human-only: the first step of deploy.promote (itself human +
  // system), run under the promote's own context: its gates decide on the
  // caller (production needs a human; publish anyway needs a human holding
  // deploy.trigger). No AI tool wraps it.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: promoteInput.omit({ runId: true, repoRoot: true, redirectChanges: true }).extend({
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
      SELECT id::text AS id, build_id, site_url, plugin_problems,
             security_headers IS NOT NULL AS has_security_headers,
             publish_summary->>'location' AS location, caelo_version, page_count, file_count
      FROM deploy_runs
      WHERE target_id = ${from.id}::uuid AND status = 'succeeded' AND build_id IS NOT NULL
      ORDER BY started_at DESC LIMIT 1
    `)) as unknown as {
      id: string;
      build_id: string | null;
      site_url: string | null;
      plugin_problems: unknown;
      location: string | null;
      has_security_headers: boolean;
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
    // #1330 — a copy goes live as it is: a build an older release staged for
    // a separate staging host (its site_url names another origin than the
    // live site's) would ship staging URLs to visitors.
    const siteBaseUrl = (await readSeoSettings(tx)).siteBaseUrl;
    if (fromRow.site_url !== null && originOf(fromRow.site_url) !== originOf(siteBaseUrl)) {
      return refused(
        `the staged build ${fromRow.id} was rendered for ${originOf(fromRow.site_url) ?? fromRow.site_url}, not for the live site (${originOf(siteBaseUrl) ?? siteBaseUrl}) — it was staged by an older Caelo release or before the site's base URL changed. Stage again, then Publish live.`,
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
      // #1329 — Publish live releases the projection state the Stage froze
      // with its build; a Stage from before #1329 froze none.
      if (!(await hasFrozenRelease(tx, fromRow.id))) {
        return refused(
          `the staged build ${fromRow.id} was staged before Caelo froze the plugin data with each Stage, so Publish live cannot release what it showed. Stage again, then Publish live.`,
        );
      }
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
    // lease: the deployments page shows it.
    await beginRunInTx(tx, {
      runId: input.runId,
      targetId: to.id,
      actorId: ctx.actorId,
      startedAt,
      renderFingerprint: null,
      // Set when the run finishes: a copy keeps the version of the build it copies.
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
      stagedLocation: fromRow.location,
      stagedHasSecurityHeaders: fromRow.has_security_headers,
      stagedCaeloVersion: fromRow.caelo_version,
      stagedPageCount: num(fromRow.page_count),
      stagedFileCount: num(fromRow.file_count),
      siteBaseUrl,
      override,
    });
  },
});

export const recheckPublishAnywayOp = defineOperation({
  name: "deploy.recheck_publish_anyway",
  readScope: "request",
  // Why human-only: a step of deploy.promote (itself human + system), run
  // right before the release of a publish-anyway decision. Reads only.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ fromRunId: z.string().uuid(), auditRunId: z.string().uuid() }).strict(),
  output: z.object({}),
  handler: async (_ctx, input, tx) => {
    const gate = await publishGateForRun(tx, input.fromRunId);
    if (gate.state === "errored" && gate.auditRunId === input.auditRunId) return ok({});
    return refused(
      `the quality check this publish-anyway decision was made for is no longer the failed check of the staged build (it is now '${gate.state}'), so nothing was released. ${gate.message}`,
    );
  },
});

export const finishPromoteOp = defineOperation({
  name: "deploy.finish_promote",
  // Why site-wide: recording Publish live records the whole site's release.
  readScope: "site",
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
      caeloVersion: z.string().nullable(),
      override: z.object({ auditRunId: z.string(), reason: z.string() }).nullable(),
      phaseTimings: z.array(phaseTimingSchema),
      /**
       * #1550 — the Staged redirect changes the build serves (redirects.release_plan's
       * `goingLive`); none when absent.
       */
      redirectChanges: z.array(redirectChangeRef).max(20_000).default([]),
      /** The live table that plan was made against (redirects.release_plan's `liveFingerprint`). */
      redirectLiveFingerprint: z.string().nullable().default(null),
    })
    .strict(),
  output: z.object({
    /** #1550 — how many of the listed redirect changes went live. */
    redirectsApplied: z.number().int(),
    /** Why none went live although some were listed (they stay Staged for the next Publish live). */
    redirectsHeldBack: z.string().nullable(),
  }),
  handler: async (ctx, input, tx) => {
    const refuse = (message: string): never => {
      throw new OperationAbortError({ kind: "HandlerError", operation: "deploy.promote", message });
    };
    const rows = (await tx.execute(sql`
      SELECT status, actor_id::text AS actor_id, target_id::text AS target_id
      FROM deploy_runs WHERE id = ${input.runId}::uuid FOR UPDATE
    `)) as unknown as { status: string; actor_id: string; target_id: string }[];
    const run = rows[0];
    if (!run) {
      refuse(
        `Publish live run ${input.runId} has no row any more; its release is live but cannot be recorded. Publish live again.`,
      );
    }
    // Only the Publish live that started this run records it (review on
    // #1251: the step is an op of its own and must authorise nothing more).
    if (run?.actor_id !== ctx.actorId || run.target_id !== input.targetId) {
      refuse(`run ${input.runId} is not a Publish live of this caller to this target.`);
    }
    if (run?.status === "succeeded") refuse(`run ${input.runId} is already recorded.`);
    // The provider released this build: production serves it, whatever the
    // row says. A row the sweep ended (its heartbeat stopped for longer than
    // the lease mid-release) is corrected rather than left claiming the
    // previous build is live — the plugin-data build and rollback read
    // what is live from here.
    if (run?.status !== "running") {
      console.error(
        "[deploy] Publish live released after its run was marked failed; recording it",
        {
          runId: input.runId,
          status: run?.status,
        },
      );
    }
    // A publish-anyway decision was checked against the gate before the
    // release (deploy.recheck_publish_anyway); the gate may have moved on
    // since (a retried audit), so here only what cannot change is checked:
    // a human holding deploy.trigger, and an audit of the published build
    // (review on #1251: the step must authorise nothing on its own).
    if (input.override) {
      const audit = (await tx.execute(sql`
        SELECT 1 AS ok FROM quality_audit_runs
        WHERE id = ${input.override.auditRunId}::uuid AND deploy_run_id = ${input.fromRunId}::uuid
      `)) as unknown as { ok: number }[];
      if (
        ctx.actorKind !== "human" ||
        audit.length === 0 ||
        !(await actorHasPermission(tx, ctx, "deploy.trigger"))
      ) {
        refuse("the publish-anyway decision does not belong to the published build.");
      }
    }
    // Released first: this transaction keeps the row locked until it
    // commits, so nobody else publishes in between.
    await releaseLiveRelease(tx, input.runId);
    let redirectsApplied = 0;
    let redirectsHeldBack: string | null = null;
    if (input.env === "production") {
      // #1550 — the redirect changes this build ships go live with it, in
      // the transaction that records it: all of the plan, or none when a
      // listed change or the live table moved on since it was made.
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
      // Epic #1107 — the pages of the build it ships get their
      // first_published_at — the staged run's start, which the build rendered.
      // #1517 — those pages take their URLs over from redirect rules there.
      await takeOverRedirectsOnFirstPublishedPages(
        ctx,
        tx,
        input.runId,
        await stampFirstPublished(tx, input.fromRunId),
      );
      // #1155 — the promoted build baked its plugin data when it was
      // staged; bakes a plugin-data build made since are pending again.
      await rewindBakesToRun(tx, input.fromRunId);
      // #1329 — live visitors get the plugin data the Stage froze, exactly
      // (deploy.start_promote checked it exists). The pointer move marks
      // the release sections stale; the drain after this commit publishes
      // them to cms_public.
      await pointLiveRelease(tx, input.fromRunId);
      await tx.execute(sql`
        UPDATE deploy_runs SET projection_run_id = ${input.fromRunId}::uuid
        WHERE id = ${input.runId}::uuid
      `);
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
          caelo_version = ${input.caeloVersion},
          lease_expires_at = NULL
      WHERE id = ${input.runId}::uuid
    `);
    // #1157 — the build carries the live redirects as they were at its
    // Stage; the provider must serve them as they are now (this release's
    // changes included). The target is behind until then — pushed after
    // this commit (deploy.promote), so no provider I/O runs inside this
    // transaction.
    await markRedirectsBehind(tx, [input.targetId]);
    return ok({ redirectsApplied, redirectsHeldBack });
  },
});

/** The run may not release (stopped, lost its lease, or its publish-anyway decision ended). */
class ReleaseRefusedError extends Error {
  override readonly name = "ReleaseRefusedError";
}

type PublishResult = Awaited<ReturnType<StaticPublisher["promoteToProduction"]>>;

/** The origin of `url`, or null when it is not one. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
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
  // #1008 — the plugin gate decides on what runs here; reconciled first,
  // outside any transaction (plugin-problems.ts).
  const unreconciled = await reconcilePluginsForBuild();
  if (unreconciled !== null) return refused(unreconciled);
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
  // #1271 — each step also records the admin's peak RSS while it ran.
  const timer = PhaseTimer.withMemory();
  const plan = started.value as PromotePlan;
  const sys = systemContextOf(ctx);
  const provider = process.env.CAELO_PROVIDER;
  const repoRoot = resolveOutputRoot(input.repoRoot);

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
  ): Promise<Result<z.infer<typeof promoteOutput>, QueryError>> => {
    const r = await execute(registry, adapter, sys, "deploy.fail_run", {
      runId,
      message: stored,
      phaseTimings: timer.phases(),
    });
    // Unrecorded, the run's lease lapses and the next run marks it failed.
    if (!r.ok) console.error("[deploy] could not record the failed run", { runId, error: r.error });
    logRunTimings(
      "publish-live",
      runId,
      timer,
      { status: "failed" },
      { message: stored, refusal: false },
    );
    return refused(reply);
  };
  /** Proof, right before an irreversible provider step, that every lease is still this run's. */
  const fence = () =>
    fenceRunLeases(steps, sys, {
      runId,
      ttlMs,
      need: { publication: false, liveRelease: true },
      lostMessage: (renewError) =>
        renewError !== null
          ? `Publish live ${runId} could not confirm it still holds its place in the publish order (${renewError}), so nothing was released. Publish live again.`
          : `Publish live ${runId} lost its place in the publish order (its lease lapsed), so nothing was released: another publish may have changed what is live. Publish live again.`,
    });

  try {
    // #1550 — which Staged redirect changes go live with this build:
    // exactly the confirmed ones (or every one Staged at this click), minus
    // the ones whose target the build does not serve. Decided before
    // anything is released, against the build's own files.
    let redirectChanges: z.infer<typeof redirectChangeRef>[] = [];
    let redirectsWaiting = 0;
    let redirectFingerprint: string | null = null;
    let redirectsHeldBack: string | null = null;
    if (plan.to.env === "production") {
      const planned = await execute(registry, adapter, sys, "redirects.release_plan", {
        fromTarget: plan.from.name,
        stagedRunId: plan.fromRunId,
        against: "staged",
        ...(input.redirectChanges ? { changes: input.redirectChanges } : {}),
        ...(input.repoRoot ? { repoRoot: input.repoRoot } : {}),
      });
      if (!planned.ok) {
        return await fail(
          `the redirects going live could not be planned: ${describeError(planned.error)}. Nothing was published; Publish live again.`,
        );
      }
      const p = planned.value as RedirectReleasePlan;
      if (p.problem !== null) {
        return await fail(
          `${p.problem} Nothing was published: fix it (Settings → Redirects shows the rules), then Publish live again.`,
        );
      }
      redirectChanges = p.goingLive.map((c) => ({ id: c.id, revision: c.revision }));
      redirectsWaiting = p.waiting.length;
    }
    const redirectsPlanned = redirectChanges.length;
    timer.lap("prepare");
    // A rollback, plugin-data build or CDN purge must not release another
    // version mid-publish. Staging is not touched: it keeps serving its slot.
    const live = await acquireLeaseStep(steps, sys, {
      op: "deploy.acquire_live_release",
      runId,
      ttlMs,
      stop,
      waitMs: LIVE_RELEASE_WAIT_MS,
      what: "live release slot",
      busyMessage: (heldBy) =>
        `${heldBy ? `another Publish live, rollback or plugin-data build (run ${heldBy})` : "a redirect push or a release of the previous Caelo version (during the update)"} kept releasing the live site for ${Math.round(LIVE_RELEASE_WAIT_MS / 60_000)} minutes, so nothing was published. Publish live again once it finished (Settings → Deployments shows it).`,
    });
    if (!live.ok) return await fail(live.message);
    heartbeat.expectLiveRelease(true);
    timer.lap("lock-wait");
    try {
      publisher = await loadStaticPublisher(provider);
    } catch (e) {
      return await fail(`promotion failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // The last point a stop is honoured is the fence the publisher runs
    // right before the new version goes live (`beforeRelease`): an upload
    // that changes nothing served may take minutes and the leases may lapse
    // meanwhile, so ownership is proven at the release itself (review on
    // #1251). Past it the run must be recorded.
    const beforeRelease = async (): Promise<void> => {
      if (stop.aborted) throw new ReleaseRefusedError(abortMessage(stop));
      const proof = await fence();
      if (!proof.ok) throw new ReleaseRefusedError(proof.message);
      // #553 — a publish-anyway decision still names the failed check of
      // this staged build (a retried audit, or another publish anyway that
      // already recorded its override, ends it): checked before the
      // release, never after it.
      if (plan.override) {
        const still = await execute(registry, adapter, ctx, "deploy.recheck_publish_anyway", {
          fromRunId: plan.fromRunId,
          auditRunId: plan.override.auditRunId,
        });
        if (!still.ok) throw new ReleaseRefusedError(describeError(still.error));
      }
    };
    let summary: PublishResult;
    try {
      // v0.2.78 — delegate to the per-provider StaticPublisher. Self-hosted
      // does the copyTreeExcept + syncContents overlay; cloud does
      // cross-bucket server-side object copies or a version release.
      summary = await publisher.promoteToProduction({
        sourceRunId: plan.buildId,
        sourceBuildDir: resolve(repoRoot, plan.from.outDir, "builds", plan.buildId),
        sourceLocation: plan.stagedLocation,
        fromTarget: plan.from,
        toTarget: plan.to,
        siteBaseUrl: plan.siteBaseUrl,
        beforeRelease,
      });
    } catch (e) {
      timer.lap("publish");
      if (e instanceof ReleaseRefusedError) return await fail(e.message);
      return await fail(`promotion failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const { phases: publishPhases, ...published } = summary;
    timer.include("publish", publishPhases ?? []);
    timer.lap("publish");

    // #1550 — planned again right before the release is recorded, under the
    // live-release lease: a change saved, kept as a draft or discarded since
    // the first plan, and the live table as it is now, decide. The finish
    // applies this plan whole, or none of it when anything moved on since.
    if (redirectChanges.length > 0) {
      const final = await execute(registry, adapter, sys, "redirects.release_plan", {
        fromTarget: plan.from.name,
        stagedRunId: plan.fromRunId,
        against: "staged",
        changes: redirectChanges,
        ...(input.repoRoot ? { repoRoot: input.repoRoot } : {}),
      });
      const p = final.ok ? (final.value as RedirectReleasePlan) : null;
      if (p === null || p.problem !== null) {
        redirectsHeldBack = p?.problem ?? (final.ok ? null : describeError(final.error));
        redirectChanges = [];
      } else {
        redirectChanges = p.goingLive.map((c) => ({ id: c.id, revision: c.revision }));
        redirectFingerprint = p.liveFingerprint;
      }
    }

    timer.lap("finish");
    const finished = await execute(registry, adapter, ctx, "deploy.finish_promote", {
      runId,
      fromRunId: plan.fromRunId,
      targetId: plan.to.id,
      env: plan.to.env,
      pageCount: plan.stagedPageCount,
      fileCount: plan.stagedFileCount,
      buildId: published.destinationBuildId,
      publishSummary: published as Record<string, unknown>,
      // #834 — a copy keeps the version that rendered the copied build.
      caeloVersion: plan.stagedCaeloVersion,
      override: plan.override,
      phaseTimings: timer.phases(),
      redirectChanges,
      redirectLiveFingerprint: redirectFingerprint,
    });
    if (!finished.ok) {
      return await fail(
        `the new build is live, but recording it failed: ${describeError(finished.error)}. Settings → Deployments may not show it as live; Publish live again to record it.`,
      );
    }
    const recorded = finished.value as {
      redirectsApplied: number;
      redirectsHeldBack: string | null;
    };
    const redirectsApplied = recorded.redirectsApplied;
    redirectsHeldBack ??= recorded.redirectsHeldBack;
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
    return ok({
      fromRunId: plan.fromRunId,
      toRunId: runId,
      buildId: published.destinationBuildId,
      ...(plan.stagedHasSecurityHeaders ? {} : { securityHeadersNote: NO_BUILD_HEADERS_NOTE }),
      redirects: {
        wentLive: redirectsApplied,
        waiting: redirectsWaiting + (redirectsPlanned - redirectsApplied),
        heldBack: redirectsHeldBack,
      },
    });
  } catch (e) {
    // A throw past the steps above is a bug; the run still ends failed and
    // releases its leases instead of waiting for them to lapse.
    timer.lap("failed-step");
    return await fail(
      `promotion failed: an unexpected error stopped it: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    await heartbeat.stop();
    timer.close();
  }
}

export const promoteDeployOp = defineStepwiseOperation({
  name: "deploy.promote",
  // Why site-wide: Publish live ships the whole staged site.
  readScope: "site",
  // Why human-only: Ops-level decision per CMS_REQUIREMENTS §6 (staging → production gate).
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: promoteInput,
  output: promoteOutput,
  stepwise: runPromote,
});
