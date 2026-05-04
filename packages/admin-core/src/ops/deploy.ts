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
 * deploy.trigger writes the deploy_runs row with status='running' and
 * a stable runId, spawns the generator, and updates the row as the
 * subprocess emits progress / done / error events. Each progress write
 * is its own short tx so the Ops dashboard can show pagesDone/total
 * while the build is in flight.
 */

import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type DatabaseAdapter,
  defineOperation,
  execute,
  type OperationRegistry,
} from "@caelo-cms/query-api";
import { type ExecutionContext, err, ok } from "@caelo-cms/shared";
import type { DeployTarget } from "@caelo-cms/static-generator";
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
  buildId: z.string().nullable(),
  progress: z.object({ pagesDone: z.number().int(), pagesTotal: z.number().int() }).nullable(),
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
      SELECT id::text AS id, name, env, out_dir, base_url, robots_default, is_default
      FROM deploy_targets
      ORDER BY env ASC, name ASC
    `)) as unknown as TargetDbRow[];
    return ok({ targets: rows.map(rowToTarget) });
  },
});

export const listDeployRunsOp = defineOperation({
  name: "deploy.list_runs",
  // CLAUDE.md §11: AI inspects deploy history when troubleshooting
  // ("did the last build succeed?"). Read-only.
  actorScope: ["human", "ai", "system"],
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
             r.page_count, r.file_count, r.error_message,
             r.build_id, r.progress
      FROM deploy_runs r JOIN deploy_targets t ON t.id = r.target_id
      ORDER BY r.started_at DESC
      LIMIT ${input.limit}
    `)) as unknown as RunDbRow[];
    return ok({ runs: rows.map(rowToRun) });
  },
});

/**
 * Resolve the path to the static-generator CLI. We look in three places
 * in order: an explicit env override, the workspace-relative path
 * `apps/static-generator/src/cli.ts` from the cwd, and node_modules
 * resolution via `import.meta.resolve`. The cwd path is what the admin
 * process uses (it runs from apps/admin/, so we walk up); the
 * `import.meta.resolve` path is the fallback for tests that pass a
 * tmpdir as `repoRoot` (the tmpdir doesn't contain the workspace).
 */
function resolveGeneratorCli(): string {
  const override = process.env.CAELO_GENERATOR_CLI;
  if (override) return override;
  // Walk up from cwd until we find apps/static-generator/src/cli.ts.
  // This survives `cd` into a subdir (the test runner's cwd) without
  // requiring the test to plumb a workspace path in.
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, "apps/static-generator/src/cli.ts");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // Final fallback: assume the workspace is the package's own ancestor.
  return resolve(import.meta.dirname, "../../../../apps/static-generator/src/cli.ts");
}

interface SubprocessProgress {
  kind: "progress";
  pagesDone: number;
  pagesTotal: number;
}
interface SubprocessDone {
  kind: "done";
  pageCount: number;
  fileCount: number;
  durationMs: number;
  buildDir: string;
}
interface SubprocessError {
  kind: "error";
  message: string;
}
type SubprocessEvent = SubprocessProgress | SubprocessDone | SubprocessError;

/**
 * Spawn the generator CLI and stream its JSON-line stdout. Each progress
 * line updates the deploy_runs row in its own tx so the Ops dashboard
 * can poll while the build runs. Returns the final done/error event.
 */
async function runGenerator(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  args: {
    cliPath: string;
    runId: string;
    target: DeployTarget;
    repoRoot: string;
    /** P13 ideas-pass — incremental deploy. When non-empty the
     *  static-generator filters its page query to these ids only,
     *  re-baking just the changed pages. */
    changedPageIds?: ReadonlyArray<string>;
  },
): Promise<{ ok: true; result: SubprocessDone } | { ok: false; message: string; stderr: string }> {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const publicUrl = process.env.PUBLIC_ADMIN_DATABASE_URL ?? process.env.PUBLIC_DATABASE_URL;
  if (!adminUrl || !publicUrl) {
    return { ok: false, message: "ADMIN_DATABASE_URL / PUBLIC_DATABASE_URL not set", stderr: "" };
  }
  return await new Promise((respond) => {
    const child = spawn("bun", ["run", args.cliPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    const stderrChunks: Buffer[] = [];
    let stdoutBuf = "";
    let finalEvent: SubprocessDone | SubprocessError | null = null;

    child.stdin.write(
      JSON.stringify({
        adminDatabaseUrl: adminUrl,
        publicDatabaseUrl: publicUrl,
        target: args.target,
        runId: args.runId,
        repoRoot: args.repoRoot,
        ...(args.changedPageIds && args.changedPageIds.length > 0
          ? { changedPageIds: [...args.changedPageIds] }
          : {}),
      }),
    );
    child.stdin.end();

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      let nl = stdoutBuf.indexOf("\n");
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        nl = stdoutBuf.indexOf("\n");
        if (line.length === 0) continue;
        let ev: SubprocessEvent;
        try {
          ev = JSON.parse(line) as SubprocessEvent;
        } catch {
          continue;
        }
        if (ev.kind === "progress") {
          // Fire-and-forget: progress updates are advisory, a stale row
          // is preferable to blocking the parent on each line.
          void execute(registry, adapter, ctx, "deploy.update_progress", {
            runId: args.runId,
            pagesDone: ev.pagesDone,
            pagesTotal: ev.pagesTotal,
          });
        } else if (ev.kind === "done" || ev.kind === "error") {
          finalEvent = ev;
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (e) => {
      respond({ ok: false, message: e.message, stderr: Buffer.concat(stderrChunks).toString() });
    });
    child.on("close", (code) => {
      const stderr = Buffer.concat(stderrChunks).toString();
      if (finalEvent && finalEvent.kind === "done") {
        respond({ ok: true, result: finalEvent });
      } else if (finalEvent && finalEvent.kind === "error") {
        respond({ ok: false, message: finalEvent.message, stderr });
      } else {
        respond({
          ok: false,
          message: `generator exited ${code} without a done event`,
          stderr,
        });
      }
    });
  });
}

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
      SET progress = ${JSON.stringify({ pagesDone: input.pagesDone, pagesTotal: input.pagesTotal })}::jsonb
      WHERE id = ${input.runId}::uuid
    `);
    return ok({});
  },
});

export const triggerDeployOp = defineOperation({
  name: "deploy.trigger",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({
    targetName: z.string().optional(),
    repoRoot: z.string().optional(),
    /** P13 ideas-pass — when supplied, the static-generator
     *  re-bakes only these pages. Other pages keep their cached HTML.
     *  Auto-redeploy passes this from the audit_events tail; manual
     *  triggers omit it for full-site rebuild. */
    changedPageIds: z.array(z.string().uuid()).optional(),
  }),
  output: z.object({
    runId: z.string(),
    targetName: z.string(),
    pageCount: z.number().int(),
    fileCount: z.number().int(),
    durationMs: z.number().int(),
    buildId: z.string(),
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

    const repoRoot = input.repoRoot ?? process.cwd();
    const cliPath = resolveGeneratorCli();

    // The trigger op needs a registry+adapter pair to land progress
    // updates on the row from inside its subprocess-watcher loop. The
    // host process sets the bridge at startup; tests do the same.
    const bridge = getDeployBridge();
    if (!bridge) {
      await tx.execute(sql`
        UPDATE deploy_runs
        SET status = 'failed', finished_at = now(),
            error_message = 'deploy-bridge not configured'
        WHERE id = ${runId}::uuid
      `);
      return err({
        kind: "HandlerError",
        operation: "deploy.trigger",
        message: "deploy-bridge not configured",
      });
    }
    const subprocess = await runGenerator(bridge.registry, bridge.adapter, ctx, {
      cliPath,
      runId,
      target: rowToTarget(target),
      repoRoot,
      changedPageIds: input.changedPageIds,
    });
    if (!subprocess.ok) {
      const tail = subprocess.stderr ? `\n${subprocess.stderr.slice(-500)}` : "";
      await tx.execute(sql`
        UPDATE deploy_runs
        SET status = 'failed', finished_at = now(),
            error_message = ${subprocess.message + tail}
        WHERE id = ${runId}::uuid
      `);
      return err({
        kind: "HandlerError",
        operation: "deploy.trigger",
        message: `generator failed: ${subprocess.message}`,
      });
    }

    await tx.execute(sql`
      UPDATE deploy_runs
      SET status = 'succeeded', finished_at = now(),
          page_count = ${subprocess.result.pageCount},
          file_count = ${subprocess.result.fileCount},
          build_id = ${runId}
      WHERE id = ${runId}::uuid
    `);

    return ok({
      runId,
      targetName: target.name,
      pageCount: subprocess.result.pageCount,
      fileCount: subprocess.result.fileCount,
      durationMs: subprocess.result.durationMs,
      buildId: runId,
    });
  },
});

/**
 * P6.2 promote — re-target the destination's `current` symlink at the
 * source target's currently-active build. No tree copy. Per-target
 * files (robots.txt, routing-manifest.json) regenerate by re-running
 * the generator if the operator wants — promote intentionally ships
 * staging's exact build to production so what staging shows is what
 * production gets.
 *
 * Caveat: the source's robots.txt was rendered with staging's
 * robotsDefault (`noindex`), so production's symlink would serve a
 * `Disallow: /` body. We patch the per-target files in the build dir
 * after the symlink swap. This is acceptable because the generator
 * never re-uses a build dir across targets — each runId is unique.
 */
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
      SELECT id::text AS id, build_id FROM deploy_runs
      WHERE target_id = ${from.id}::uuid AND status = 'succeeded' AND build_id IS NOT NULL
      ORDER BY started_at DESC LIMIT 1
    `)) as unknown as { id: string; build_id: string | null }[];
    const fromRow = fromRunRows[0];
    const fromRunId = fromRow?.id;
    const buildId = fromRow?.build_id;
    if (!fromRunId || !buildId) {
      return err({
        kind: "HandlerError",
        operation: "deploy.promote",
        message: `no succeeded build to promote from ${from.name}`,
      });
    }

    const root = input.repoRoot ?? process.cwd();
    const toDir = resolve(root, to.out_dir);
    const toBuildsDir = join(toDir, "builds");
    const toCurrent = join(toDir, "current");
    const fromBuildDir = resolve(root, from.out_dir, "builds", buildId);

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
      // Materialise an overlay build dir on the destination that
      // mirrors the source's build but with the destination's
      // robots.txt + routing-manifest values. Then sync that overlay
      // into the destination's `current/` so Caddy serves it.
      const overlayBuildId = `${buildId}-${to.name}`;
      const overlayDir = join(toBuildsDir, overlayBuildId);
      await mkdir(overlayDir, { recursive: true });
      const { buildRobotsTxt } = await import("@caelo-cms/static-generator");
      // Copy the source build's files (excluding the per-target ones)
      // into the overlay. Use file-by-file copy to avoid the bind-mount
      // tree-recreate issue when overwriting.
      await copyTreeExcept(fromBuildDir, overlayDir, ["robots.txt", "routing-manifest.json"]);
      await writeFile(join(overlayDir, "robots.txt"), buildRobotsTxt(to.robots_default), "utf8");
      const manifestRaw = await Bun.file(join(fromBuildDir, "routing-manifest.json"))
        .text()
        .catch(() => "{}");
      try {
        const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
        manifest.target = to.name;
        manifest.env = to.env;
        await writeFile(
          join(overlayDir, "routing-manifest.json"),
          JSON.stringify(manifest, null, 2),
          "utf8",
        );
      } catch {
        // Malformed manifest — overlay just won't have one.
      }

      // Sync overlay → current.
      await mkdir(toCurrent, { recursive: true });
      await syncContentsInto(overlayDir, toCurrent);

      await tx.execute(sql`
        UPDATE deploy_runs
        SET status = 'succeeded', finished_at = now(),
            page_count = (SELECT page_count FROM deploy_runs WHERE id = ${fromRunId}::uuid),
            file_count = (SELECT file_count FROM deploy_runs WHERE id = ${fromRunId}::uuid),
            build_id = ${overlayBuildId}
        WHERE id = ${toRunId}::uuid
      `);
      return ok({ fromRunId, toRunId, buildId: overlayBuildId });
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
    const targetRows = (await tx.execute(sql`
      SELECT id::text AS id, name, env, out_dir, base_url, robots_default, is_default
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
      SELECT build_id FROM deploy_runs
      WHERE id = ${input.runId}::uuid
        AND target_id = ${target.id}::uuid
        AND status = 'succeeded'
        AND build_id IS NOT NULL
      LIMIT 1
    `)) as unknown as { build_id: string }[];
    const buildId = priorRows[0]?.build_id;
    if (!buildId) {
      return err({
        kind: "HandlerError",
        operation: "deploy.rollback",
        message: "no matching succeeded build for that target",
      });
    }
    const root = input.repoRoot ?? process.cwd();
    const outDir = resolve(root, target.out_dir);
    const buildDir = join(outDir, "builds", buildId);
    const currentDir = join(outDir, "current");
    try {
      await mkdir(currentDir, { recursive: true });
      await syncContentsInto(buildDir, currentDir);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err({
        kind: "HandlerError",
        operation: "deploy.rollback",
        message: `rollback failed: ${message}`,
      });
    }
    const newRunRows = (await tx.execute(sql`
      INSERT INTO deploy_runs (target_id, actor_id, status, finished_at, build_id)
      VALUES (${target.id}::uuid, ${ctx.actorId}::uuid, 'succeeded', now(), ${buildId})
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const newRunId = newRunRows[0]?.id ?? "";
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

export function setDeployBridge(b: DeployBridge): void {
  bridge = b;
}
export function getDeployBridge(): DeployBridge | null {
  return bridge;
}

/**
 * Copy every file in `src` into `dst` at the same relative path,
 * skipping the names listed in `exceptNames` at the root level.
 */
async function copyTreeExcept(src: string, dst: string, exceptNames: string[]): Promise<void> {
  const skip = new Set(exceptNames);
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(src, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (rel === "" && skip.has(entry.name)) continue;
      if (entry.isDirectory()) {
        await mkdir(join(dst, childRel), { recursive: true });
        await walk(childRel);
      } else {
        await mkdir(join(dst, childRel, ".."), { recursive: true });
        await copyFile(join(src, childRel), join(dst, childRel));
      }
    }
  };
  await walk("");
}

/**
 * Mirror `src` into `dst` so dst contains exactly src's tree. Used by
 * deploy.promote and deploy.rollback to update the destination's
 * `current/` directory in place without breaking serving-layer bind
 * mounts.
 */
async function syncContentsInto(src: string, dst: string): Promise<void> {
  const tryRm = async (path: string, opts: Parameters<typeof rm>[1] = {}) => {
    try {
      await rm(path, opts);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EFAULT" && code !== "ENOENT") throw e;
    }
  };
  const srcFiles = new Set<string>();
  const collect = async (rel: string): Promise<void> => {
    const entries = await readdir(join(src, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) await collect(childRel);
      else srcFiles.add(childRel);
    }
  };
  await collect("");
  for (const rel of srcFiles) {
    await mkdir(join(dst, rel, ".."), { recursive: true });
    await copyFile(join(src, rel), join(dst, rel));
  }
  const sweep = async (rel: string): Promise<void> => {
    const here = join(dst, rel);
    if (!(await stat(here).catch(() => null))) return;
    const entries = await readdir(here, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await sweep(childRel);
        const remaining = await readdir(join(dst, childRel)).catch(() => []);
        if (remaining.length === 0) await tryRm(join(dst, childRel), { recursive: false });
      } else if (!srcFiles.has(childRel)) {
        await tryRm(join(dst, childRel), { force: true });
      }
    }
  };
  await sweep("");
}
