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
 * deploy-trigger.ts, Publish live (`deploy.promote`) in deploy-promote.ts
 * and `deploy.rollback` in deploy-rollback.ts: none holds a transaction
 * while it builds, uploads or releases (#1211, #1225, #1250).
 */

import {
  type DatabaseAdapter,
  defineOperation,
  type OperationRegistry,
} from "@caelo-cms/query-api";
import { ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { rowToTarget, type TargetDbRow, targetRow } from "./deploy-common.js";
import { settleOrphanedRuns } from "./deploy-run-lifecycle.js";

export { effectiveOutDir, localBuildArchiveDir } from "./deploy-common.js";
export { promoteDeployOp } from "./deploy-promote.js";
export { triggerDeployOp } from "./deploy-trigger.js";

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
  progress: { pagesDone: number; pagesTotal: number } | null;
  build_kind: "site" | "plugin_data";
}

function rowToRun(r: RunDbRow): z.infer<typeof runRow> {
  const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : String(v));
  const num = (v: number | string | null) =>
    v === null ? null : typeof v === "string" ? Number.parseInt(v, 10) : v;
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
    progress: r.progress,
    buildKind: r.build_kind,
  };
}

export const listDeployTargetsOp = defineOperation({
  name: "deploy.list_targets",
  readScope: "request",
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
  readScope: "request",
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
  handler: async (ctx, input, tx) => {
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
    // #1307 — a run whose build died answers failed, not running. A
    // plugin's read reports it too, but does not correct the host's run rows.
    const settled = await settleOrphanedRuns(tx, rows, { correctRows: ctx.actorKind !== "plugin" });
    return ok({ runs: settled.map(rowToRun) });
  },
});

export const getDeployRunOp = defineOperation({
  name: "deploy.get_run",
  readScope: "request",
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
    // #1307 — a run whose build died answers failed, not running.
    const [row] = await settleOrphanedRuns(tx, rows);
    return ok({ run: row ? rowToRun(row) : null });
  },
});

export const updateDeployProgressOp = defineOperation({
  name: "deploy.update_progress",
  readScope: "request",
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
    // #1288 — the database time of this write and of the first one (with
    // its count) give deploy.stage_status this run's pace.
    await tx.execute(sql`
      UPDATE deploy_runs
      SET progress = jsonb_build_object(
            'pagesDone', ${input.pagesDone}::int,
            'pagesTotal', ${input.pagesTotal}::int,
            'at', to_jsonb(clock_timestamp()),
            'firstAt', COALESCE(progress->'firstAt', to_jsonb(clock_timestamp())),
            'firstDone', COALESCE(progress->'firstDone', to_jsonb(${input.pagesDone}::int)))
      WHERE id = ${input.runId}::uuid
    `);
    return ok({});
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
