// SPDX-License-Identifier: MPL-2.0

/**
 * A Stage's search index reports how far its embedding is (progress.ts,
 * migration 0795), and the Stage status, which get_stage_status, the
 * Deployments page and the editor's Staging menu read, says it: passages so
 * far, tasks, about how long Publish live still waits. Before, a Stage
 * whose first index with semantic search took 14 minutes said only
 * "search index still building".
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { describeStageRun, type ExecutionContext, type StageStatusRun } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t-index-progress",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let pluginId = "";
let runId = "";

async function asSystem<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return await fn(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function op<T>(name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function stageRun(): Promise<StageStatusRun> {
  const { runs } = await op<{ runs: StageStatusRun[] }>("deploy.stage_status", {
    deployRunId: runId,
  });
  return runs[0] as StageStatusRun;
}

const progress = (task: number, embedded: number, toEmbed: number) =>
  op("collections.index_progress", {
    runId,
    pluginId,
    collection: "pages",
    task,
    embedded,
    toEmbed,
  });

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  runId = crypto.randomUUID();
  pluginId = await asSystem(async (tx) => {
    const p = (await tx`
      INSERT INTO plugins (slug, version, tier, status, manifest_json, source_code, submitted_by)
      VALUES (${`t-progress-${runId.slice(0, 8)}`}, '1.0.0', 2, 'awaiting_activation',
              ('{}'::text)::jsonb, 'export {};', ${SYS.actorId}::uuid)
      RETURNING id::text AS id`) as { id: string }[];
    const id = p[0]?.id as string;
    await tx`INSERT INTO deploy_runs (id, target_id, actor_id, status, started_at, finished_at, page_count)
             SELECT ${runId}::uuid, id, ${SYS.actorId}::uuid, 'succeeded', now() - interval '5 minutes', now(), 320
               FROM deploy_targets WHERE name = 'staging'`;
    await tx`INSERT INTO collection_releases (run_id, plugin_id, collection, state)
             VALUES (${runId}::uuid, ${id}::uuid, 'pages', 'pending')`;
    return id;
  });
});

afterAll(async () => {
  await asSystem(async (tx) => {
    await tx`DELETE FROM deploy_runs WHERE id = ${runId}::uuid`;
    await tx`DELETE FROM plugins WHERE id = ${pluginId}::uuid`;
  });
  await adapter.close();
});

describe("a Stage's search index progress", () => {
  it("says nothing about passages while the index embeds none", async () => {
    const run = await stageRun();
    expect(run.searchIndexes?.[0]).toMatchObject({ state: "pending" });
    expect(run.searchIndexes?.[0]?.progress).toBeUndefined();
    expect(describeStageRun(run)).toContain("search index still building (t-progress-");
  });

  it("adds up the tasks' counts and estimates the time left from their pace", async () => {
    await progress(0, 100, 400);
    await progress(1, 150, 400);
    // A minute of embedding so far.
    await asSystem(
      (tx) => tx`UPDATE collection_releases
                    SET progress = jsonb_set(progress, '{startedAt}',
                          to_jsonb(to_char((now() - interval '60 seconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
                  WHERE run_id = ${runId}::uuid`,
    );
    await progress(1, 150, 400);
    const run = await stageRun();
    const p = run.searchIndexes?.[0]?.progress;
    expect(p).toMatchObject({ embedded: 250, toEmbed: 800, tasks: 2 });
    // 250 in 60 s: 550 left take about 132 s.
    expect(p?.remainingMs).toBeGreaterThan(120_000);
    expect(p?.remainingMs).toBeLessThan(140_000);
    expect(describeStageRun(run)).toMatch(
      /semantic search 250 of 800 passages on 2 tasks, about 2 min( \d+ s)? left\) — Publish live waits for it/,
    );
  });

  it("a wider attempt starts the count over", async () => {
    await op("collections.index_reset_progress", { runId });
    expect((await stageRun()).searchIndexes?.[0]?.progress).toBeUndefined();
  });

  it("a ready index shows no progress and no wait", async () => {
    await progress(0, 400, 400);
    await op("collections.index_done", {
      runId,
      pluginId,
      collection: "pages",
      releaseKey: "release-0123456789abcdef01234567.json",
      stats: {},
    });
    const run = await stageRun();
    expect(run.searchIndexes?.[0]).toMatchObject({ state: "ready" });
    expect(run.searchIndexes?.[0]?.progress).toBeUndefined();
    expect(describeStageRun(run)).toContain("search index ready");
    // A late report of a finished index is not recorded.
    expect(await progress(0, 1, 400)).toEqual({ recorded: false });
  });
});
