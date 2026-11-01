// SPDX-License-Identifier: MPL-2.0

/**
 * #1288 — deploy.stage_status against a real Postgres: only Stage runs
 * (staging site builds) are listed, newest first; a running build gets
 * its pace from the timestamps deploy.update_progress stores; a failed
 * run names its step and reason; the AI may read it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext, StageStatusRun } from "@caelo-cms/shared";
import { SQL } from "bun";
import { ORPHANED_RUN_MESSAGE } from "../ops/deploy-run-lifecycle.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "human",
  requestId: "deploy-stage-status-test",
};
const AI: ExecutionContext = { ...HUMAN, actorKind: "ai" };
const SYSTEM: ExecutionContext = { ...HUMAN, actorKind: "system" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx);
    });
  } finally {
    await sql.end();
  }
}

const SUCCESS_PHASES = [
  { phase: "prepare", ms: 4000 },
  { phase: "generator", ms: 80000 },
  { phase: "generator.compose", ms: 70000 },
  { phase: "publish", ms: 10000 },
];

/** Insert a run `agoSeconds` before now on the target named `target`. */
async function seedRun(args: {
  target: "staging" | "production";
  status: "pending" | "running" | "succeeded" | "failed";
  agoSeconds: number;
  durationSeconds?: number;
  buildKind?: "site" | "plugin_data";
  phases?: unknown[];
  error?: string;
  pageCount?: number;
  /**
   * A running run's lease, seconds from now (negative: lapsed). Default
   * two minutes ahead — a build that is alive renews it (#1211).
   */
  leaseSeconds?: number;
}): Promise<string> {
  const id = crypto.randomUUID();
  const finished =
    args.durationSeconds === undefined ? null : args.agoSeconds - args.durationSeconds;
  const lease = args.status === "running" ? (args.leaseSeconds ?? 120) : null;
  await withSql(
    (tx) => tx`
      INSERT INTO deploy_runs (id, target_id, actor_id, status, started_at, finished_at,
                               phase_timings, error_message, page_count, build_kind,
                               lease_expires_at)
      SELECT ${id}::uuid, t.id, ${HUMAN.actorId}::uuid, ${args.status},
             clock_timestamp() - make_interval(secs => ${args.agoSeconds}),
             CASE WHEN ${finished}::int IS NULL THEN NULL
                  ELSE clock_timestamp() - make_interval(secs => ${finished}::int) END,
             ${args.phases ? JSON.stringify(args.phases) : null}::text::jsonb,
             ${args.error ?? null}, ${args.pageCount ?? null}, ${args.buildKind ?? "site"},
             CASE WHEN ${lease}::int IS NULL THEN NULL
                  ELSE clock_timestamp() + make_interval(secs => ${lease}::int) END
        FROM deploy_targets t WHERE t.name = ${args.target}`,
  );
  return id;
}

async function stageStatus(
  ctx: ExecutionContext,
  input: Record<string, unknown>,
): Promise<StageStatusRun[]> {
  const r = await execute(registry, adapter, ctx, "deploy.stage_status", input);
  if (!r.ok) throw new Error(`deploy.stage_status: ${JSON.stringify(r.error)}`);
  return (r.value as { runs: StageStatusRun[] }).runs;
}

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

beforeEach(async () => {
  await withSql((tx) => tx`DELETE FROM deploy_runs`);
});

afterAll(async () => {
  await withSql((tx) => tx`DELETE FROM deploy_runs`);
  await adapter.close();
});

describe("deploy.stage_status (#1288)", () => {
  it("lists only Stage runs, newest first, and names a failed run's step and reason", async () => {
    await seedRun({
      target: "staging",
      status: "succeeded",
      agoSeconds: 3600,
      durationSeconds: 94,
      phases: SUCCESS_PHASES,
      pageCount: 122,
    });
    const failed = await seedRun({
      target: "staging",
      status: "failed",
      agoSeconds: 600,
      durationSeconds: 95,
      phases: [
        { phase: "prepare", ms: 3735 },
        { phase: "generator", ms: 88986 },
      ],
      error: "122 render failure(s) would ship as missing content",
    });
    await seedRun({
      target: "production",
      status: "succeeded",
      agoSeconds: 300,
      durationSeconds: 5,
    });
    await seedRun({
      target: "staging",
      status: "succeeded",
      agoSeconds: 60,
      durationSeconds: 2,
      buildKind: "plugin_data",
    });

    const runs = await stageStatus(AI, {});
    expect(runs.map((r) => r.status)).toEqual(["failed", "succeeded"]);
    const f = runs[0] as StageStatusRun;
    expect(f.runId).toBe(failed);
    expect(f.phase).toBe("failed");
    expect(f.failedPhase).toBe("generator");
    expect(f.error).toContain("122 render failure");
    expect(f.elapsedMs).toBeGreaterThanOrEqual(94_000);
    expect(f.eta).toBeNull();
    expect(runs[1]?.pagesTotal).toBe(122);

    expect(await stageStatus(AI, { limit: 1 })).toHaveLength(1);
  });

  it("estimates a running build from this run's pace, stored by deploy.update_progress", async () => {
    await seedRun({
      target: "staging",
      status: "succeeded",
      agoSeconds: 3600,
      durationSeconds: 94,
      phases: SUCCESS_PHASES,
    });
    const running = await seedRun({ target: "staging", status: "running", agoSeconds: 20 });

    // Before any page: the median of the recent successful Stages.
    const preparing = (await stageStatus(AI, { deployRunId: running }))[0];
    expect(preparing?.phase).toBe("preparing");
    expect(preparing?.eta?.basis).toBe("last_successful_run");

    const progress = (pagesDone: number) =>
      execute(registry, adapter, SYSTEM, "deploy.update_progress", {
        runId: running,
        pagesDone,
        pagesTotal: 400,
      });
    expect((await progress(100)).ok).toBe(true);
    await Bun.sleep(300);
    expect((await progress(200)).ok).toBe(true);

    const stored = (await withSql(
      (tx) => tx`SELECT progress FROM deploy_runs WHERE id = ${running}::uuid`,
    )) as { progress: Record<string, unknown> }[];
    expect(stored[0]?.progress).toMatchObject({ pagesDone: 200, pagesTotal: 400, firstDone: 100 });
    expect(Date.parse(String(stored[0]?.progress.at))).toBeGreaterThan(
      Date.parse(String(stored[0]?.progress.firstAt)),
    );

    const building = (await stageStatus(AI, { deployRunId: running }))[0];
    expect(building?.phase).toBe("building");
    expect(building?.pagesDone).toBe(200);
    expect(building?.eta?.basis).toBe("this_run_rate");
    expect(building?.eta?.includesPublish).toBe(true);
    // 200 pages left at ~3 ms/page plus the 10 s median publish.
    expect(building?.eta?.remainingMs).toBeGreaterThanOrEqual(10_000);
    expect(building?.eta?.remainingMs).toBeLessThan(20_000);
  });

  it("returns no run for an id that is not a Stage build", async () => {
    const prod = await seedRun({
      target: "production",
      status: "running",
      agoSeconds: 10,
    });
    expect(await stageStatus(HUMAN, { deployRunId: prod })).toEqual([]);
    expect(await stageStatus(HUMAN, { deployRunId: crypto.randomUUID() })).toEqual([]);
  });

  it("a running Stage whose lease lapsed reads as failed with the restart hint, and the row says so (#1307)", async () => {
    await seedRun({
      target: "staging",
      status: "succeeded",
      agoSeconds: 3600,
      durationSeconds: 94,
      phases: SUCCESS_PHASES,
    });
    // Its process died (OOM): it stopped renewing its lease a while ago.
    const dead = await seedRun({
      target: "staging",
      status: "running",
      agoSeconds: 900,
      leaseSeconds: -600,
    });
    const alive = await seedRun({ target: "staging", status: "running", agoSeconds: 30 });

    const runs = await stageStatus(AI, {});
    const byId = new Map(runs.map((r) => [r.runId, r]));
    expect(byId.get(alive)).toMatchObject({ status: "running" });
    const d = byId.get(dead);
    expect(d).toMatchObject({ status: "failed", phase: "failed", eta: null });
    expect(d?.error).toBe(ORPHANED_RUN_MESSAGE);
    expect(d?.finishedAt).not.toBeNull();

    // Corrected in the database without another Stage starting: every
    // reader (deploy.get_run, the deployments list) sees the same.
    const rows = (await withSql(
      (tx) => tx`SELECT status, error_message, lease_expires_at FROM deploy_runs
                 WHERE id = ${dead}::uuid`,
    )) as { status: string; error_message: string; lease_expires_at: unknown }[];
    expect(rows[0]).toEqual({
      status: "failed",
      error_message: ORPHANED_RUN_MESSAGE,
      lease_expires_at: null,
    });
    const alsoDead = await seedRun({
      target: "staging",
      status: "running",
      agoSeconds: 400,
      leaseSeconds: -1,
    });
    const got = await execute(registry, adapter, AI, "deploy.get_run", { runId: alsoDead });
    if (!got.ok) throw new Error(JSON.stringify(got.error));
    expect((got.value as { run: { status: string; errorMessage: string } }).run).toMatchObject({
      status: "failed",
      errorMessage: ORPHANED_RUN_MESSAGE,
    });
    const listed = await execute(registry, adapter, HUMAN, "deploy.list_runs", {});
    if (!listed.ok) throw new Error(JSON.stringify(listed.error));
    const statuses = new Map(
      (listed.value as { runs: { id: string; status: string }[] }).runs.map((r) => [
        r.id,
        r.status,
      ]),
    );
    expect(statuses.get(alive)).toBe("running");
    expect(statuses.get(dead)).toBe("failed");
  });

  it("says why there is no estimate when no successful Stage recorded its steps", async () => {
    const running = await seedRun({ target: "staging", status: "running", agoSeconds: 5 });
    const run = (await stageStatus(AI, { deployRunId: running }))[0];
    expect(run?.eta).toBeNull();
    expect(run?.etaUnavailable).toContain("no successful Stage");
  });
});
