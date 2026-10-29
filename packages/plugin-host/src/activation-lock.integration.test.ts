// SPDX-License-Identifier: MPL-2.0

/**
 * #1144 — two activations of one plugin never run their seed at once,
 * across connections (the lock lives in Postgres, not in this process).
 *
 * #1220 — the lock is a committed lease (migration 0403): no connection is
 * held while the seed runs, so the seed's own storage transactions run
 * under the pool guard; a dead holder's lease lapses; the previous
 * release's advisory lock is honoured during a rolling update.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { legacyActivationLockKey, runActivationSerialized } from "./activation-lock.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: "t1220" };

async function leaseRows(slug: string): Promise<{ holder: string; live: boolean }[]> {
  return a.withAdminTransaction(
    SYS,
    async (tx) =>
      (await tx.execute(sql`
        SELECT holder, expires_at > clock_timestamp() AS live
        FROM plugin_activation_leases WHERE slug = ${slug}
      `)) as unknown as { holder: string; live: boolean }[],
  );
}
let a: DatabaseAdapter;
let b: DatabaseAdapter;

beforeAll(() => {
  // Two adapters = two pools, as two admin instances would have.
  a = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  b = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
});

afterAll(async () => {
  await a.close();
  await b.close();
});

describe("runActivationSerialized", () => {
  it("runs a check-then-insert seed of one plugin once at a time", async () => {
    let rows = 0;
    const seed = async () => {
      const seen = rows;
      await new Promise((r) => setTimeout(r, 150));
      if (seen === 0) rows += 1;
    };
    await Promise.all([
      runActivationSerialized({ adapter: a }, SYSTEM_ACTOR_ID, "t1144-plugin", seed),
      runActivationSerialized({ adapter: b }, SYSTEM_ACTOR_ID, "t1144-plugin", seed),
    ]);
    expect(rows).toBe(1);
  });

  it("does not serialize different plugins", async () => {
    const order: string[] = [];
    const slow = async () => {
      order.push("slow:start");
      await new Promise((r) => setTimeout(r, 300));
      order.push("slow:end");
    };
    const fast = async () => {
      order.push("fast");
    };
    const first = runActivationSerialized({ adapter: a }, SYSTEM_ACTOR_ID, "t1144-a", slow);
    await new Promise((r) => setTimeout(r, 50));
    await runActivationSerialized({ adapter: b }, SYSTEM_ACTOR_ID, "t1144-b", fast);
    await first;
    expect(order).toEqual(["slow:start", "fast", "slow:end"]);
  });

  it("holds no connection while the seed runs: the seed's own transactions pass the pool guard", async () => {
    const seeded = await runActivationSerialized(
      { adapter: a },
      SYSTEM_ACTOR_ID,
      "t1220-guard",
      () =>
        a.withAdminTransaction(SYS, async (tx) => {
          const rows = (await tx.execute(sql`SELECT 1 AS n`)) as unknown as { n: number }[];
          return rows[0]?.n;
        }),
    );
    expect(seeded).toBe(1);
    // Released once the seed ended.
    expect(await leaseRows("t1220-guard")).toEqual([]);
  });

  it("releases the lease when the seed throws", async () => {
    await expect(
      runActivationSerialized({ adapter: a }, SYSTEM_ACTOR_ID, "t1220-throw", async () => {
        throw new Error("seed failed");
      }),
    ).rejects.toThrow("seed failed");
    expect(await leaseRows("t1220-throw")).toEqual([]);
  });

  it("takes over the lapsed lease of a dead holder", async () => {
    await a.withAdminTransaction(SYS, async (tx) => {
      await tx.execute(sql`
        INSERT INTO plugin_activation_leases (slug, holder, expires_at)
        VALUES ('t1220-dead', 'dead-instance', clock_timestamp() - interval '1 second')
      `);
    });
    let ran = false;
    await runActivationSerialized({ adapter: b }, SYSTEM_ACTOR_ID, "t1220-dead", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(await leaseRows("t1220-dead")).toEqual([]);
  });

  it("waits for a live lease and gives up loudly after the wait, without running the seed", async () => {
    await a.withAdminTransaction(SYS, async (tx) => {
      await tx.execute(sql`
        INSERT INTO plugin_activation_leases (slug, holder, expires_at)
        VALUES ('t1220-busy', 'other-instance', clock_timestamp() + interval '1 minute')
      `);
    });
    let ran = false;
    await expect(
      runActivationSerialized(
        { adapter: b },
        SYSTEM_ACTOR_ID,
        "t1220-busy",
        async () => {
          ran = true;
        },
        { waitMs: 300 },
      ),
    ).rejects.toThrow(/another activation of this plugin/);
    expect(ran).toBe(false);
    // The other activation's lease is untouched.
    expect(await leaseRows("t1220-busy")).toEqual([{ holder: "other-instance", live: true }]);
  });

  it("renews the lease on a heartbeat while a long seed runs", async () => {
    let lapsedDuringSeed: boolean | null = null;
    await runActivationSerialized(
      { adapter: a },
      SYSTEM_ACTOR_ID,
      "t1220-beat",
      async () => {
        await Bun.sleep(900);
        const rows = await leaseRows("t1220-beat");
        lapsedDuringSeed = rows[0]?.live !== true;
      },
      { ttlMs: 400, heartbeatMs: 100 },
    );
    expect(lapsedDuringSeed).toBe(false);
  });

  it("waits while the previous release's advisory lock is held (rolling update)", async () => {
    const raw = new SQL(ADMIN_URL as string, { max: 1 });
    const order: string[] = [];
    try {
      const reserved = await raw.reserve();
      try {
        await reserved`BEGIN`;
        await reserved`SELECT pg_advisory_xact_lock(hashtextextended(${legacyActivationLockKey("t1220-legacy")}, 0))`;
        const activation = runActivationSerialized(
          { adapter: a },
          SYSTEM_ACTOR_ID,
          "t1220-legacy",
          async () => {
            order.push("new-release seed");
          },
        );
        await Bun.sleep(300);
        order.push("previous-release seed done");
        await reserved`COMMIT`;
        await activation;
      } finally {
        reserved.release();
      }
    } finally {
      await raw.end();
    }
    expect(order).toEqual(["previous-release seed done", "new-release seed"]);
  });
});
