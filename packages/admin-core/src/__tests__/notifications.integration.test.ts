// SPDX-License-Identifier: MPL-2.0

/**
 * notifications.aggregate — the bell's failed-deploy count reflects
 * CURRENT problems only. A failed staging run followed by a succeeded
 * staging run is resolved and must not count; a target whose latest
 * finished run failed counts once, however many failures preceded it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "notifications-failed-deploys",
};

const STAGING = "notif-test-staging";
const PRODUCTION = "notif-test-production";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function withSystemTx<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await withSystemTx(async (tx) => {
    await tx`DELETE FROM deploy_runs`;
    await tx`DELETE FROM deploy_targets WHERE name IN (${STAGING}, ${PRODUCTION})`;
  });
}

async function seedTarget(name: string, env: "staging" | "production"): Promise<string> {
  return withSystemTx(async (tx) => {
    const rows = (await tx`
      INSERT INTO deploy_targets (name, env, out_dir)
      VALUES (${name}, ${env}, ${`/tmp/${name}`})
      RETURNING id
    `) as { id: string }[];
    return rows[0]!.id;
  });
}

/** Inserts a run `minutesAgo` minutes in the past with the given status. */
async function seedRun(targetId: string, status: string, minutesAgo: number): Promise<void> {
  await withSystemTx(async (tx) => {
    await tx`
      INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at)
      VALUES (
        ${targetId}, ${SYSTEM.actorId}, ${status},
        now() - make_interval(mins => ${minutesAgo}),
        ${status === "running" ? null : new Date(Date.now() - minutesAgo * 60_000 + 1000)}
      )
    `;
  });
}

async function failedDeploys(): Promise<number> {
  const r = await execute(registry, adapter, SYSTEM, "notifications.aggregate", {});
  if (!r.ok) throw new Error(`notifications.aggregate failed: ${JSON.stringify(r.error)}`);
  return (r.value as { failedDeploys: number }).failedDeploys;
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("notifications.aggregate failedDeploys", () => {
  it("ignores failures superseded by a later successful run on the same target", async () => {
    await wipe();
    const staging = await seedTarget(STAGING, "staging");
    for (let i = 0; i < 7; i++) await seedRun(staging, "failed", 100 - i);
    await seedRun(staging, "succeeded", 10);
    expect(await failedDeploys()).toBe(0);
  });

  it("counts each target whose latest finished run failed exactly once", async () => {
    await wipe();
    const staging = await seedTarget(STAGING, "staging");
    const production = await seedTarget(PRODUCTION, "production");
    await seedRun(staging, "succeeded", 60);
    await seedRun(staging, "failed", 30);
    await seedRun(staging, "failed", 20);
    await seedRun(production, "failed", 50);
    await seedRun(production, "succeeded", 40);
    expect(await failedDeploys()).toBe(1);
  });

  it("keeps an open failure visible while a retry is still running", async () => {
    await wipe();
    const staging = await seedTarget(STAGING, "staging");
    await seedRun(staging, "failed", 30);
    await seedRun(staging, "running", 1);
    expect(await failedDeploys()).toBe(1);
  });

  it("still reports a failure older than seven days when nothing succeeded since", async () => {
    await wipe();
    const staging = await seedTarget(STAGING, "staging");
    await seedRun(staging, "failed", 60 * 24 * 10);
    expect(await failedDeploys()).toBe(1);
  });
});
