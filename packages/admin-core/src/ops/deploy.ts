// SPDX-License-Identifier: MPL-2.0

/**
 * Phase 6 — deploy ops. Trigger-only AI surface (CMS_REQUIREMENTS §3.1):
 * `deploy.trigger` accepts `actorScope: ["human", "ai", "system"]` so the AI
 * can request a deploy via a tool call, but the generator binary itself
 * lives in `apps/static-generator` and is not reachable through any tool —
 * AI cannot modify it.
 *
 * `deploy.promote` copies the staging dist to the production dist
 * atomically (rsync-style) so promotion does not require a rebuild. This is
 * the Ops-view two-step path; the editor "Publish" button maps to a single
 * deploy.trigger against the default target.
 *
 * The `deploy_runs` table *is* the audit trail for builds (start/finish,
 * status, page count, error message) — no separate `recordAudit` call. The
 * audit log still picks up the *act* of triggering via the wrapper at
 * the route layer if the route writes one; it isn't required here because
 * the deploy_runs row already records who, when, and the outcome.
 */

import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { defineOperation } from "@caelo/query-api";
import { err, ok } from "@caelo/shared";
import { type DeployTarget, generateSite } from "@caelo/static-generator";
import { sql } from "drizzle-orm";
import { z } from "zod";

const targetRow = z.object({
  id: z.string(),
  name: z.string(),
  env: z.enum(["dev", "staging", "production"]),
  outDir: z.string(),
  baseUrl: z.string(),
  robotsDefault: z.enum(["index", "noindex"]),
  isDefault: z.boolean(),
});

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
});

interface TargetDbRow {
  id: string;
  name: string;
  env: "dev" | "staging" | "production";
  out_dir: string;
  base_url: string;
  robots_default: "index" | "noindex";
  is_default: boolean;
}

function rowToTarget(r: TargetDbRow): z.infer<typeof targetRow> {
  return {
    id: r.id,
    name: r.name,
    env: r.env,
    outDir: r.out_dir,
    baseUrl: r.base_url,
    robotsDefault: r.robots_default,
    isDefault: r.is_default,
  };
}

function rowToRun(r: {
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
}): z.infer<typeof runRow> {
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
  };
}

export const listDeployTargetsOp = defineOperation({
  name: "deploy.list_targets",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({}),
  output: z.object({ targets: z.array(targetRow) }),
  handler: async (_ctx, _input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, name, env, out_dir, base_url, robots_default, is_default
      FROM deploy_targets
      ORDER BY env ASC, name ASC
    `)) as unknown as TargetDbRow[];
    return ok({ targets: rows.map(rowToTarget) });
  },
});

export const listDeployRunsOp = defineOperation({
  name: "deploy.list_runs",
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
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
             r.page_count, r.file_count, r.error_message
      FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
      ORDER BY r.started_at DESC
      LIMIT ${input.limit}
    `)) as unknown as Parameters<typeof rowToRun>[0][];
    return ok({ runs: rows.map(rowToRun) });
  },
});

export const triggerDeployOp = defineOperation({
  name: "deploy.trigger",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({
    targetName: z.string().optional(),
    /** Repo root for resolving relative out_dir; defaults to process.cwd(). */
    repoRoot: z.string().optional(),
  }),
  output: z.object({
    runId: z.string(),
    targetName: z.string(),
    pageCount: z.number().int(),
    fileCount: z.number().int(),
    durationMs: z.number().int(),
  }),
  handler: async (ctx, input, tx) => {
    const targetRows = (await tx.execute(
      input.targetName
        ? sql`
            SELECT id::text AS id, name, env, out_dir, base_url, robots_default, is_default
            FROM deploy_targets WHERE name = ${input.targetName} LIMIT 1`
        : sql`
            SELECT id::text AS id, name, env, out_dir, base_url, robots_default, is_default
            FROM deploy_targets WHERE is_default LIMIT 1`,
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

    const runIdRows = (await tx.execute(sql`
      INSERT INTO deploy_runs (target_id, actor_id, status)
      VALUES (${target.id}::uuid, ${ctx.actorId}::uuid, 'running')
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const runId = runIdRows[0]?.id;
    if (!runId) {
      return err({
        kind: "HandlerError",
        operation: "deploy.trigger",
        message: "could not create deploy_runs row",
      });
    }

    const targetForGen: DeployTarget = rowToTarget(target);
    try {
      const result = await generateSite({
        tx,
        target: targetForGen,
        repoRoot: input.repoRoot,
      });
      await tx.execute(sql`
        UPDATE deploy_runs
        SET status = 'succeeded',
            finished_at = now(),
            page_count = ${result.pageCount},
            file_count = ${result.fileCount}
        WHERE id = ${runId}::uuid
      `);
      return ok({
        runId,
        targetName: target.name,
        pageCount: result.pageCount,
        fileCount: result.fileCount,
        durationMs: result.durationMs,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await tx.execute(sql`
        UPDATE deploy_runs
        SET status = 'failed', finished_at = now(), error_message = ${message}
        WHERE id = ${runId}::uuid
      `);
      return err({
        kind: "HandlerError",
        operation: "deploy.trigger",
        message: `generator failed: ${message}`,
      });
    }
  },
});

export const promoteDeployOp = defineOperation({
  name: "deploy.promote",
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
  }),
  handler: async (ctx, input, tx) => {
    if (input.fromTarget === input.toTarget) {
      return err({
        kind: "HandlerError",
        operation: "deploy.promote",
        message: "fromTarget and toTarget must differ",
      });
    }
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, name, env, out_dir, base_url, robots_default, is_default
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
      SELECT id::text AS id FROM deploy_runs
      WHERE target_id = ${from.id}::uuid AND status = 'succeeded'
      ORDER BY started_at DESC LIMIT 1
    `)) as unknown as { id: string }[];
    const fromRunId = fromRunRows[0]?.id;
    if (!fromRunId) {
      return err({
        kind: "HandlerError",
        operation: "deploy.promote",
        message: `no succeeded build to promote from ${from.name}`,
      });
    }

    const root = input.repoRoot ?? process.cwd();
    const fromDir = resolve(root, from.out_dir);
    const toDir = resolve(root, to.out_dir);
    const toRunIdRows = (await tx.execute(sql`
      INSERT INTO deploy_runs (target_id, actor_id, status)
      VALUES (${to.id}::uuid, ${ctx.actorId}::uuid, 'running')
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const toRunId = toRunIdRows[0]?.id;
    if (!toRunId) {
      return err({
        kind: "HandlerError",
        operation: "deploy.promote",
        message: "could not create deploy_runs row for promotion target",
      });
    }
    try {
      await rm(toDir, { recursive: true, force: true });
      await mkdir(toDir, { recursive: true });
      await cp(fromDir, toDir, { recursive: true });
      await tx.execute(sql`
        UPDATE deploy_runs
        SET status = 'succeeded', finished_at = now(),
            page_count = (SELECT page_count FROM deploy_runs WHERE id = ${fromRunId}::uuid),
            file_count = (SELECT file_count FROM deploy_runs WHERE id = ${fromRunId}::uuid)
        WHERE id = ${toRunId}::uuid
      `);
      return ok({ fromRunId, toRunId });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await tx.execute(sql`
        UPDATE deploy_runs
        SET status = 'failed', finished_at = now(), error_message = ${message}
        WHERE id = ${toRunId}::uuid
      `);
      return err({
        kind: "HandlerError",
        operation: "deploy.promote",
        message: `promotion failed: ${message}`,
      });
    }
  },
});
