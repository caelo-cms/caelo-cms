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
 * deploy-trigger.ts and Publish live (`deploy.promote`) in
 * deploy-promote.ts: neither holds a transaction while it builds or
 * uploads (#1211, #1225).
 */

import { join, resolve } from "node:path";
import {
  type DatabaseAdapter,
  defineOperation,
  type OperationRegistry,
  type QueryError,
  type TransactionRunner,
} from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok, type Result } from "@caelo-cms/shared";
import { readSeoSettings } from "@caelo-cms/static-generator";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { LIVE_RELEASE_WAIT_MS, tryLockLiveRelease } from "../deploy/live-release-lock.js";
import { resolveOutputRoot } from "../deploy/output-root.js";
import { syncRedirectsInTx } from "../deploy/redirect-sync.js";
import { tryLockStagingPublication } from "../deploy/staging-publication-lock.js";
import { loadStaticPublisher, type PublishSummary } from "../deploy/static-publisher.js";
import { forgetAllBakes } from "../plugin-data/stale-pages.js";
import { jsonbParam } from "../sql-helpers.js";
import {
  effectiveOutDir,
  rowToTarget,
  runStartedAt,
  type TargetDbRow,
  targetRow,
} from "./deploy-common.js";

export { effectiveOutDir } from "./deploy-common.js";
export { promoteDeployOp } from "./deploy-promote.js";
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
 *
 * #1225 — ordered with every other live release by the live-release lease
 * (live-release-lock.ts). While a Publish live or plugin-data build holds
 * it, the rollback waits OUTSIDE any transaction and tries again; once it
 * gets the row, the release and its record are one short transaction.
 */
export const rollbackDeployOp = defineOperation({
  name: "deploy.rollback",
  // Why human-only: Ops-level decision per CMS_REQUIREMENTS §6.
  actorScope: ["human", "system"],
  database: "cms_admin",
  // #1225 — no connection is held while it waits for a running publish.
  transaction: "none",
  input: z
    .object({
      targetName: z.string(),
      runId: z.string().uuid(),
      repoRoot: z.string().optional(),
    })
    .strict(),
  output: z.object({ buildId: z.string(), newRunId: z.string() }),
  handler: async (ctx, input, detached) => {
    const deadline = Date.now() + LIVE_RELEASE_WAIT_MS;
    let pause = 100;
    for (;;) {
      const attempt = await detached.transaction((tx) => rollbackOnce(ctx, input, tx));
      if (attempt.kind === "done") return attempt.result;
      if (Date.now() >= deadline) {
        return err({
          kind: "HandlerError",
          operation: "deploy.rollback",
          message: `${attempt.heldBy ? `a Publish live or plugin-data build (run ${attempt.heldBy})` : "a release of the previous Caelo version (during the update)"} kept releasing the live site for ${Math.round(LIVE_RELEASE_WAIT_MS / 60_000)} minutes, so nothing was rolled back. Roll back again once it finished (Settings → Deployments shows it).`,
        });
      }
      await new Promise((r) => setTimeout(r, pause));
      pause = Math.min(pause * 2, 2_000);
    }
  },
});

/** One rollback attempt, in one transaction: done, or the live release is busy. */
async function rollbackOnce(
  ctx: ExecutionContext,
  input: { targetName: string; runId: string; repoRoot?: string | undefined },
  tx: TransactionRunner,
): Promise<
  | {
      readonly kind: "done";
      readonly result: Result<{ buildId: string; newRunId: string }, QueryError>;
    }
  | { readonly kind: "busy"; readonly heldBy: string | null }
> {
  const done = (result: Result<{ buildId: string; newRunId: string }, QueryError>) =>
    ({ kind: "done", result }) as const;
  const startedAt = await runStartedAt(tx);
  const targetRows = (await tx.execute(sql`
    SELECT id::text AS id, name, env, out_dir, base_url, robots_default, is_default, page_url_style
    FROM deploy_targets WHERE name = ${input.targetName} LIMIT 1
  `)) as unknown as TargetDbRow[];
  const target = targetRows[0];
  if (!target) {
    return done(
      err({
        kind: "HandlerError",
        operation: "deploy.rollback",
        message: `target not found: ${input.targetName}`,
      }),
    );
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
    return done(
      err({
        kind: "HandlerError",
        operation: "deploy.rollback",
        message: "no matching succeeded build for that target",
      }),
    );
  }
  // A CDN purge, Publish live or plugin-data build must not release another
  // version mid-rollback. Never waits here: a busy lease ends this
  // transaction and the caller waits outside it.
  const lock = await tryLockLiveRelease(tx, { skipLocked: true });
  if (!lock.locked) return { kind: "busy", heldBy: lock.heldBy?.runId ?? null };
  const root = resolveOutputRoot(input.repoRoot);
  const outDir = resolve(root, target.out_dir);
  const buildDir = join(outDir, "builds", buildId);
  let summary: PublishSummary;
  try {
    // v0.2.78 — delegate to the per-provider StaticPublisher.
    const publisher = await loadStaticPublisher(process.env.CAELO_PROVIDER);
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
    return done(
      err({
        kind: "HandlerError",
        operation: "deploy.rollback",
        message: `rollback failed: ${message}`,
      }),
    );
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
  return done(ok({ buildId, newRunId }));
}

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
