// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1140 — the scheduler tick against a real Postgres: the due-table
 * ops (migration 0550) and `runSchedulerTick`.
 *
 *   - a new task is due at once; after a run it is due again after its
 *     cadence (minus the slack), not earlier;
 *   - concurrent ticks run a task once (the claim);
 *   - a failing task is recorded and does not stop the tick;
 *   - a cron task's next due time is its next occurrence;
 *   - the budget defers the rest to the next tick, unclaimed;
 *   - a run that outlives its lease keeps the lease (no second run);
 *   - finishing a task another tick took over is refused;
 *   - only the system actor reaches the due-table.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import type { ScheduledTask } from "../scheduler/task.js";
import { TASK_DUE_SLACK_SECONDS } from "../scheduler/task.js";
import { runSchedulerTick } from "../scheduler/tick.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const PFX = "core:t1140-";
const SYSTEM = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "t1140",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

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

interface Row {
  task_key: string;
  due_in_s: number;
  lease_holder: string | null;
  last_outcome: string | null;
  last_error: string | null;
}

async function row(key: string): Promise<Row | undefined> {
  const rows = (await asSystem(
    (tx) => tx`
      SELECT task_key, extract(epoch FROM next_due_at - now())::float AS due_in_s,
             lease_holder, last_outcome, last_error
      FROM scheduled_tasks WHERE task_key = ${key}`,
  )) as Row[];
  return rows[0];
}

function counting(
  key: string,
  cadence: ScheduledTask["cadence"],
  body: () => Promise<string | undefined> = async () => undefined,
  leaseSeconds = 60,
): ScheduledTask & { runs: () => number } {
  let runs = 0;
  return {
    key,
    cadence,
    leaseSeconds,
    run: async () => {
      runs += 1;
      return body();
    },
    runs: () => runs,
  };
}

const tick = (tasks: ScheduledTask[], holder = "test/1", extra: { budgetMs?: number } = {}) =>
  runSchedulerTick({ adapter, registry, tasks, holder, log: () => undefined, ...extra });

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

beforeEach(async () => {
  await asSystem((tx) => tx`DELETE FROM scheduled_tasks WHERE task_key LIKE ${`${PFX}%`}`);
});

afterAll(async () => {
  await asSystem((tx) => tx`DELETE FROM scheduled_tasks WHERE task_key LIKE ${`${PFX}%`}`);
  await adapter.close();
});

describe("runSchedulerTick (#1140)", () => {
  it("runs a new task at once, then not again before its cadence", async () => {
    const hourly = counting(`${PFX}hourly`, { everySeconds: 3600 }, async () => "swept 3");
    const first = await tick([hourly]);
    expect(first.ran).toEqual([
      expect.objectContaining({ key: hourly.key, outcome: "ok", detail: "swept 3" }),
    ]);
    const r = await row(hourly.key);
    expect(r?.last_outcome).toBe("ok");
    expect(r?.lease_holder).toBeNull();
    // Due again after the cadence minus the slack, counted from the start.
    expect(r?.due_in_s).toBeGreaterThan(3600 - TASK_DUE_SLACK_SECONDS - 5);
    expect(r?.due_in_s).toBeLessThanOrEqual(3600 - TASK_DUE_SLACK_SECONDS);

    const second = await tick([hourly]);
    expect(second.ran).toEqual([]);
    expect(second.notDue).toBe(1);
    expect(hourly.runs()).toBe(1);
  });

  it("an every-tick task runs on every tick", async () => {
    const each = counting(`${PFX}each`, { everySeconds: 0 });
    await tick([each]);
    await tick([each]);
    expect(each.runs()).toBe(2);
  });

  it("concurrent ticks run a task once", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = counting(`${PFX}slow`, { everySeconds: 600 }, async () => {
      await gate;
      return undefined;
    });
    const a = tick([slow], "instance-a/1");
    // Let the first tick claim and start it.
    await Bun.sleep(200);
    const b = await tick([slow], "instance-b/1");
    expect(b.ran).toEqual([]);
    expect(b.notDue).toBe(1);
    release();
    expect((await a).ran.map((r) => r.outcome)).toEqual(["ok"]);
    expect(slow.runs()).toBe(1);
  });

  it("a failing task is recorded and the tick goes on", async () => {
    const broken = counting(`${PFX}broken`, { everySeconds: 3600 }, async () => {
      throw new Error("the provider said no");
    });
    const fine = counting(`${PFX}fine`, { everySeconds: 3600 });
    const report = await tick([broken, fine]);
    expect(report.ran.map((r) => [r.key, r.outcome])).toEqual([
      [broken.key, "failed"],
      [fine.key, "ok"],
    ]);
    const r = await row(broken.key);
    expect(r?.last_outcome).toBe("failed");
    expect(r?.last_error).toBe("the provider said no");
    // Retried at its next due time, not on the next tick.
    expect(r?.due_in_s).toBeGreaterThan(3000);
  });

  it("a cron task is due at its next occurrence", async () => {
    const next = new Date(Date.now() + 42 * 60 * 1000);
    const cron = counting(`${PFX}cron`, { nextAfter: () => next });
    await tick([cron]);
    const r = await row(cron.key);
    expect(Math.abs((r?.due_in_s ?? 0) - 42 * 60)).toBeLessThan(5);
  });

  it("the budget defers the remaining tasks, unclaimed", async () => {
    const first = counting(`${PFX}budget-1`, { everySeconds: 0 }, async () => {
      await Bun.sleep(30);
      return undefined;
    });
    const later = counting(`${PFX}budget-2`, { everySeconds: 0 });
    const report = await tick([first, later], "test/1", { budgetMs: 10 });
    expect(report.ran.map((r) => r.key)).toEqual([first.key]);
    expect(report.deferred).toEqual([later.key]);
    expect(later.runs()).toBe(0);
    // Never claimed: the next tick runs it.
    expect(await row(later.key)).toBeUndefined();
    expect((await tick([later])).ran.map((r) => r.key)).toEqual([later.key]);
  });

  it("a run that outlives its lease keeps the lease, so no other tick starts it again", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // The shortest lease the claim takes; the tick stops waiting after it.
    const stuck = counting(
      `${PFX}stuck`,
      { everySeconds: 0 },
      async () => {
        await gate;
        return undefined;
      },
      10,
    );
    try {
      const report = await tick([stuck], "test/stuck");
      expect(report.ran.map((r) => r.outcome)).toEqual(["timed_out"]);
      // Not finished: the lease stands until it expires.
      expect((await row(stuck.key))?.lease_holder).toBe("test/stuck");
    } finally {
      release();
    }
  }, 20_000);

  it("finishing a task another tick took over is refused", async () => {
    const key = `${PFX}taken`;
    const claim = await execute(registry, adapter, SYSTEM, "scheduled_tasks.claim", {
      taskKey: key,
      holder: "old/1",
      leaseSeconds: 10,
    });
    expect(claim.ok && (claim.value as { claimed: boolean }).claimed).toBe(true);
    // The lease expired and another tick took it.
    await asSystem(
      (tx) =>
        tx`UPDATE scheduled_tasks SET lease_until = now() - interval '1 second' WHERE task_key = ${key}`,
    );
    const retaken = await execute(registry, adapter, SYSTEM, "scheduled_tasks.claim", {
      taskKey: key,
      holder: "new/1",
      leaseSeconds: 10,
    });
    expect(retaken.ok && (retaken.value as { claimed: boolean }).claimed).toBe(true);
    const late = await execute(registry, adapter, SYSTEM, "scheduled_tasks.finish", {
      taskKey: key,
      holder: "old/1",
      outcome: "ok",
      error: null,
      durationMs: 5,
      afterSeconds: 60,
      at: null,
    });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(JSON.stringify(late.error)).toContain("no longer leased by old/1");
    expect((await row(key))?.lease_holder).toBe("new/1");
  });

  it("refuses a finish with both or neither next-due field", async () => {
    const base = {
      taskKey: `${PFX}shape`,
      holder: "h/1",
      outcome: "ok",
      error: null,
      durationMs: 1,
    };
    for (const next of [
      { afterSeconds: null, at: null },
      { afterSeconds: 5, at: new Date().toISOString() },
    ]) {
      const r = await execute(registry, adapter, SYSTEM, "scheduled_tasks.finish", {
        ...base,
        ...next,
      });
      expect(r.ok).toBe(false);
    }
  });

  it("refuses keys that are not core: or plugin: keys", async () => {
    const r = await execute(registry, adapter, SYSTEM, "scheduled_tasks.claim", {
      taskKey: "anything",
      holder: "h/1",
      leaseSeconds: 10,
    });
    expect(r.ok).toBe(false);
  });

  it("only the system actor runs the due-table ops", async () => {
    for (const actorKind of ["human", "ai"] as const) {
      const r = await execute(
        registry,
        adapter,
        { ...SYSTEM, actorKind },
        "scheduled_tasks.claim",
        { taskKey: `${PFX}scope`, holder: "h/1", leaseSeconds: 10 },
      );
      expect(r.ok).toBe(false);
    }
  });

  it("RLS hides the due-table from every session but the system's", async () => {
    await tick([counting(`${PFX}rls`, { everySeconds: 3600 })]);
    const sql = new SQL(ADMIN_URL as string);
    try {
      const seen = (await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'human'");
        return await tx`SELECT task_key FROM scheduled_tasks WHERE task_key = ${`${PFX}rls`}`;
      })) as unknown[];
      expect(seen).toHaveLength(0);
    } finally {
      await sql.end();
    }
  });
});
