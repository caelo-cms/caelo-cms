// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1210 — no transaction may wait for a second connection of its own
 * pool. Production 2026-10-28: the admin pool sat at its cap with every
 * connection `idle in transaction` and every request hung, because ops took
 * a second checkout while holding their transaction and Bun.SQL waits for a
 * free connection forever.
 *
 *  1. the deadlock itself, on a bare Bun.SQL pool (what the adapter guards);
 *  2. the same shape through the adapter fails at once, loudly, and the pool
 *     keeps answering;
 *  3. an exhausted pool answers within the acquire deadline;
 *  4. a detached op (`transaction: "none"`) holds nothing, so the ops it
 *     calls are not nested;
 *  5. the allowlist and the migration-0392 timeouts;
 *  6. #1254 — render-time work JOINS the held transaction as a savepoint.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ExecutionContext, ok } from "@caelo-cms/shared";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  afterCommit,
  DatabaseAdapter,
  defineOperation,
  execute,
  joinHeldTransaction,
  LONG_TRANSACTION_ALLOWLIST,
  NestedPoolCheckoutError,
  OperationRegistry,
} from "../index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB urls required");

const POOL_MAX = 3;
const ctx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000001210",
  actorKind: "system",
  requestId: "pool-guard-test",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

/** Resolves to "settled" or "pending" after `ms`, whichever comes first. */
async function settledWithin(p: Promise<unknown>, ms: number): Promise<"settled" | "pending"> {
  return Promise.race([
    p.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    Bun.sleep(ms).then(() => "pending" as const),
  ]);
}

beforeAll(() => {
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_URL,
    poolMax: POOL_MAX,
  });
  registry = new OperationRegistry();
  registry.register(
    defineOperation({
      name: "pool_guard.inner",
      readScope: "request",
      actorScope: ["system"],
      database: "cms_admin",
      input: z.object({}),
      output: z.object({ n: z.number() }),
      handler: async (_ctx, _input, tx) => {
        const rows = (await tx.execute(sql`SELECT 1 AS n`)) as unknown as { n: number }[];
        return ok({ n: rows[0]?.n ?? 0 });
      },
    }),
  );
  // The production shape: a handler holding its transaction that runs
  // another op through execute() — a second checkout of the same pool.
  registry.register(
    defineOperation({
      name: "pool_guard.nests",
      readScope: "request",
      actorScope: ["system"],
      database: "cms_admin",
      input: z.object({}),
      output: z.object({ inner: z.boolean() }),
      handler: async (c, _input, tx) => {
        await tx.execute(sql`SELECT 1`);
        const inner = await execute(registry, adapter, c, "pool_guard.inner", {});
        return ok({ inner: inner.ok });
      },
    }),
  );
  registry.register(
    defineOperation({
      name: "pool_guard.detached",
      readScope: "request",
      actorScope: ["system"],
      database: "cms_admin",
      transaction: "none",
      input: z.object({ touchTx: z.boolean() }),
      output: z.object({ results: z.number(), actor: z.string() }),
      handler: async (c, input, tx) => {
        if (input.touchTx) await tx.execute(sql`SELECT 1`);
        // Several steps, each its own short op — none nested.
        const all = await Promise.all(
          Array.from({ length: POOL_MAX + 2 }, () =>
            execute(registry, adapter, c, "pool_guard.inner", {}),
          ),
        );
        // A step of its own: a short transaction under the op's identity.
        const actor = await tx.transaction(async (t) => {
          const rows = (await t.execute(
            sql`SELECT current_setting('caelo.actor_id') AS actor`,
          )) as unknown as { actor: string }[];
          return rows[0]?.actor ?? "";
        });
        return ok({ results: all.filter((r) => r.ok).length, actor });
      },
    }),
  );
});

afterAll(async () => {
  await adapter.close();
});

describe("the deadlock the guard prevents (bare Bun.SQL)", () => {
  it("POOL_MAX transactions that each wait for a second connection hang for good", async () => {
    const pool = new SQL(ADMIN_URL, { max: POOL_MAX, idleTimeout: 30 });
    const holders = Array.from({ length: POOL_MAX }, () =>
      pool.begin(async (tx) => {
        await tx`SELECT 1`;
        await Bun.sleep(50);
        // Inside the transaction, a query on the pool itself.
        await pool`SELECT 'nested'`;
      }),
    );
    const all = Promise.all(holders);
    // Every connection is held and every holder waits for one: nothing
    // ever settles (Bun.SQL has no acquire timeout).
    expect(await settledWithin(all, 2_000)).toBe("pending");
    await pool.close({ timeout: 0 });
    await all.catch(() => undefined);
  });
});

describe("nested checkout guard", () => {
  it("an op that runs another op inside its transaction throws, naming both", async () => {
    let thrown: unknown;
    try {
      await execute(registry, adapter, ctx, "pool_guard.nests", {});
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NestedPoolCheckoutError);
    const message = (thrown as Error).message;
    expect(message).toContain("pool_guard.inner");
    expect(message).toContain("pool_guard.nests");
    expect(message).toContain("admin database pool");
  });

  it("POOL_MAX concurrent nesting transactions fail fast instead of deadlocking the pool", async () => {
    const holders = Array.from({ length: POOL_MAX }, () =>
      adapter.withAdminTransaction(ctx, async (tx) => {
        await tx.execute(sql`SELECT 1`);
        await Bun.sleep(50);
        await adapter.withAdminTransaction(ctx, async (inner) => inner.execute(sql`SELECT 1`));
      }),
    );
    const outcomes = await Promise.allSettled(holders);
    for (const o of outcomes) {
      expect(o.status).toBe("rejected");
      expect((o as PromiseRejectedResult).reason).toBeInstanceOf(NestedPoolCheckoutError);
    }
    // Nothing is left holding a connection: the pool still answers.
    const after = await execute(registry, adapter, ctx, "pool_guard.inner", {});
    expect(after.ok).toBe(true);
  });

  it("refuses the raw pool handles inside a transaction of the same pool", async () => {
    await expect(
      adapter.withAdminTransaction(ctx, async () => {
        adapter.rawAdmin();
      }),
    ).rejects.toBeInstanceOf(NestedPoolCheckoutError);
    await expect(
      adapter.withAdminTransaction(ctx, async () => {
        void adapter.admin;
      }),
    ).rejects.toBeInstanceOf(NestedPoolCheckoutError);
  });

  it("allows the other pool: an admin transaction may open a public one", async () => {
    const n = await adapter.withAdminTransaction(ctx, async () =>
      adapter.withPublicTransaction(ctx, async (tx) => {
        const rows = (await tx.execute(sql`SELECT 7 AS n`)) as unknown as { n: number }[];
        return rows[0]?.n;
      }),
    );
    expect(n).toBe(7);
  });

  it("lets through work a transaction started but did not await, once it ended", async () => {
    let later: Promise<unknown> = Promise.resolve();
    await adapter.withAdminTransaction(ctx, async () => {
      later = Bun.sleep(50).then(() =>
        adapter.withAdminTransaction(ctx, async (tx) => tx.execute(sql`SELECT 1`)),
      );
    });
    await later;
  });

  it("#1225 — Publish live, the approvals and the plugin-data build are on neither list", () => {
    for (const holder of [
      "deploy.promote",
      "deploy.execute_proposal",
      "quality_audits.publish_anyway",
      "quality_audits.execute_proposal",
      "deploy.build_plugin_data",
    ]) {
      expect(LONG_TRANSACTION_ALLOWLIST.has(holder)).toBe(false);
    }
  });
});

describe("#1254 — render-time work joins the held transaction", () => {
  const pluginCtx: ExecutionContext = {
    actorId: "00000000-0000-0000-0000-000000001254",
    actorKind: "system",
    requestId: "pool-guard-join",
    pluginId: "00000000-0000-0000-0000-00000000aaaa",
  };

  beforeAll(() => {
    // Reads the holder's uncommitted row (a temp table exists only on the
    // holder's own connection) and reports the identity it ran under.
    registry.register(
      defineOperation({
        name: "pool_guard.join_probe",
        actorScope: ["system"],
        database: "cms_admin",
        input: z.object({ fail: z.boolean().optional() }),
        output: z.object({ seen: z.number(), actor: z.string(), plugin: z.string() }),
        handler: async (_c, input, tx) => {
          await tx.execute(sql`INSERT INTO pg_temp.join_probe (v) VALUES (100)`);
          if (input.fail) throw new Error("probe failed on purpose");
          const rows = (await tx.execute(sql`
            SELECT (SELECT count(*)::int FROM pg_temp.join_probe) AS seen,
                   current_setting('caelo.actor_id') AS actor,
                   current_setting('caelo.plugin_id') AS plugin
          `)) as unknown as { seen: number; actor: string; plugin: string }[];
          return ok(rows[0] as { seen: number; actor: string; plugin: string });
        },
      }),
    );
    registry.register(
      defineOperation({
        name: "pool_guard.join_effect",
        actorScope: ["system"],
        database: "cms_admin",
        input: z.object({ label: z.string(), fail: z.boolean().optional() }),
        output: z.object({}),
        handler: async (_c, input, tx) => {
          afterCommit(tx, { label: input.label, run: () => void effects.push(input.label) });
          if (input.fail) throw new Error("effect op failed after registering");
          return ok({});
        },
      }),
    );
  });

  const effects: string[] = [];

  async function holderWithProbeTable<T>(
    fn: (tx: Parameters<Parameters<DatabaseAdapter["withAdminTransaction"]>[1]>[0]) => Promise<T>,
  ): Promise<T> {
    return adapter.withAdminTransaction(ctx, async (tx) => {
      await tx.execute(sql`CREATE TEMP TABLE join_probe (v int) ON COMMIT DROP`);
      await tx.execute(sql`INSERT INTO join_probe (v) VALUES (1)`);
      return fn(tx);
    });
  }

  it("runs on the holder's connection, under its own identity, and restores the holder's", async () => {
    const out = await holderWithProbeTable(async (tx) => {
      const joined = await joinHeldTransaction(() =>
        execute(registry, adapter, pluginCtx, "pool_guard.join_probe", {}),
      );
      const after = (await tx.execute(sql`
        SELECT current_setting('caelo.actor_id') AS actor,
               current_setting('caelo.plugin_id') AS plugin,
               (SELECT count(*)::int FROM join_probe) AS rows
      `)) as unknown as { actor: string; plugin: string; rows: number }[];
      return { joined, after: after[0] };
    });
    expect(out.joined).toEqual({
      ok: true,
      value: { seen: 2, actor: pluginCtx.actorId, plugin: pluginCtx.pluginId as string },
    });
    // The holder is itself again, and the joined write is part of its transaction.
    expect(out.after).toEqual({ actor: ctx.actorId, plugin: "", rows: 2 });
  });

  it("a failing joined call rolls back only its savepoint", async () => {
    const out = await holderWithProbeTable(async (tx) => {
      const joined = await joinHeldTransaction(() =>
        execute(registry, adapter, pluginCtx, "pool_guard.join_probe", { fail: true }),
      );
      const rows = (await tx.execute(sql`
        SELECT (SELECT count(*)::int FROM join_probe) AS n, current_setting('caelo.actor_id') AS actor
      `)) as unknown as { n: number; actor: string }[];
      return { joined: joined.ok, after: rows[0] };
    });
    expect(out).toEqual({ joined: false, after: { n: 1, actor: ctx.actorId } });
  });

  it("parallel joined calls run one at a time on the one connection", async () => {
    const out = await holderWithProbeTable(async () =>
      joinHeldTransaction(() =>
        Promise.all(
          Array.from({ length: 7 }, () =>
            execute(registry, adapter, pluginCtx, "pool_guard.join_probe", {}),
          ),
        ),
      ),
    );
    const seen = out.map((r) => (r.ok ? r.value.seen : -1)).sort((a, b) => a - b);
    // Each call saw the rows of the calls before it, never a half-done one.
    expect(seen).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it("POOL_MAX holders that all join never wait for a second connection", async () => {
    const holders = Array.from({ length: POOL_MAX * 2 }, () =>
      holderWithProbeTable(async () => {
        await Bun.sleep(30);
        return joinHeldTransaction(() =>
          execute(registry, adapter, pluginCtx, "pool_guard.join_probe", {}),
        );
      }),
    );
    expect(await settledWithin(Promise.all(holders), 5_000)).toBe("settled");
    for (const r of await Promise.all(holders)) expect(r.ok).toBe(true);
  });

  it("a joined call's post-commit effects wait for the holder's commit, and drop with its rollback", async () => {
    effects.length = 0;
    await holderWithProbeTable(async () => {
      await joinHeldTransaction(() =>
        execute(registry, adapter, pluginCtx, "pool_guard.join_effect", { label: "kept" }),
      );
      expect(effects).toEqual([]);
    });
    expect(effects).toEqual(["kept"]);
    await expect(
      holderWithProbeTable(async () => {
        await joinHeldTransaction(() =>
          execute(registry, adapter, pluginCtx, "pool_guard.join_effect", { label: "dropped" }),
        );
        throw new Error("holder rolls back");
      }),
    ).rejects.toThrow("holder rolls back");
    expect(effects).toEqual(["kept"]);
    // A joined call that fails after registering an effect rolls back its
    // savepoint; the holder handles the failure and commits — the effect
    // of the undone work must not run (PR #1273 review).
    await holderWithProbeTable(async () => {
      const failed = await joinHeldTransaction(() =>
        execute(registry, adapter, pluginCtx, "pool_guard.join_effect", {
          label: "undone",
          fail: true,
        }),
      );
      expect(failed.ok).toBe(false);
    });
    expect(effects).toEqual(["kept"]);
  });

  it("deferred work runs after the holder released its connection, even after a rollback", async () => {
    const ran: string[] = [];
    await expect(
      holderWithProbeTable(async () => {
        const deferred = await adapter.deferUntilHeldTransactionEnds(async () => {
          // A checkout of its own: the holder's connection is back in the pool.
          await adapter.withAdminTransaction(ctx, (t) => t.execute(sql`SELECT 1`));
          ran.push("after");
        });
        expect(deferred).toBe(true);
        expect(ran).toEqual([]);
        throw new Error("holder rolls back");
      }),
    ).rejects.toThrow("holder rolls back");
    expect(ran).toEqual(["after"]);
    const now = await adapter.deferUntilHeldTransactionEnds(async () => void ran.push("now"));
    expect(now).toBe(false);
    expect(ran).toEqual(["after", "now"]);
  });

  it("a nested checkout that does not join still throws, and raw handles never join", async () => {
    await expect(
      holderWithProbeTable(async () =>
        execute(registry, adapter, pluginCtx, "pool_guard.join_probe", {}),
      ),
    ).rejects.toBeInstanceOf(NestedPoolCheckoutError);
    await expect(
      holderWithProbeTable(async () =>
        joinHeldTransaction(async () => {
          adapter.rawAdmin();
        }),
      ),
    ).rejects.toBeInstanceOf(NestedPoolCheckoutError);
  });
});

describe("#1220 — the long-transaction allowlist lifts the timeouts, never the guard", () => {
  it("static-generator.build runs without the 0392 timeouts and still may not nest", async () => {
    const holder = "static-generator.build";
    expect(LONG_TRANSACTION_ALLOWLIST.get(holder)?.reason).toBeTruthy();
    let own: string | undefined;
    await expect(
      adapter.withAdminTransaction(
        ctx,
        async (tx) => {
          const rows = (await tx.execute(
            sql`SELECT current_setting('statement_timeout') AS v`,
          )) as unknown as { v: string }[];
          own = rows[0]?.v;
          await adapter.withAdminTransaction(ctx, async (inner) => inner.execute(sql`SELECT 1`));
        },
        { holder },
      ),
    ).rejects.toBeInstanceOf(NestedPoolCheckoutError);
    expect(own).toBe("0");
  });

  it("every long-transaction entry says why", () => {
    for (const entry of LONG_TRANSACTION_ALLOWLIST.values()) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });
});

describe("pool acquire deadline", () => {
  it("an exhausted pool answers with an actionable error within the deadline", async () => {
    const small = new DatabaseAdapter({
      adminDatabaseUrl: ADMIN_URL,
      publicDatabaseUrl: PUBLIC_URL,
      poolMax: 2,
      poolAcquireTimeoutMs: 300,
    });
    try {
      await small.verifyRoles();
      const held = [await small.rawAdmin().reserve(), await small.rawAdmin().reserve()];
      const started = Date.now();
      const r = await execute(registry, small, ctx, "pool_guard.inner", {});
      const waited = Date.now() - started;
      expect(r.ok).toBe(false);
      if (!r.ok && r.error.kind === "HandlerError") {
        expect(r.error.message).toContain("no free connection");
        expect(r.error.message).toContain("Retry in a few seconds");
      } else {
        throw new Error(`expected a HandlerError, got ${JSON.stringify(r)}`);
      }
      expect(waited).toBeLessThan(3_000);
      for (const c of held) c.release();
      // The timed-out waiter took no connection with it.
      const again = await execute(registry, small, ctx, "pool_guard.inner", {});
      expect(again.ok).toBe(true);
    } finally {
      await small.close();
    }
  });
});

describe("detached operations", () => {
  it("run other ops without holding a transaction", async () => {
    const r = await execute(registry, adapter, ctx, "pool_guard.detached", { touchTx: false });
    expect(r).toEqual({ ok: true, value: { results: POOL_MAX + 2, actor: ctx.actorId } });
  });

  it("refuse any use of the tx they are handed", async () => {
    const r = await execute(registry, adapter, ctx, "pool_guard.detached", { touchTx: true });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === "HandlerError") {
      expect(r.error.message).toContain("pool_guard.detached is a detached operation");
    } else {
      throw new Error(`expected a HandlerError, got ${JSON.stringify(r)}`);
    }
  });
});

describe("migration 0392 session timeouts", () => {
  it("every new session of either database runs under them", async () => {
    for (const url of [ADMIN_URL, PUBLIC_URL]) {
      const one = new SQL(url, { max: 1 });
      try {
        const rows = (await one`
          SELECT current_setting('statement_timeout') AS statement,
                 current_setting('lock_timeout') AS lock,
                 current_setting('idle_in_transaction_session_timeout') AS idle
        `) as { statement: string; lock: string; idle: string }[];
        expect(rows[0]).toEqual({ statement: "1min", lock: "15s", idle: "1min" });
      } finally {
        await one.close();
      }
    }
  });

  it("a transaction left idle is ended by Postgres and the pool recovers", async () => {
    await expect(
      adapter.withAdminTransaction(ctx, async (tx) => {
        // The 0392 limit is a minute; shorten it for this transaction only.
        await tx.execute(
          sql`SELECT set_config('idle_in_transaction_session_timeout', '200ms', true)`,
        );
        await Bun.sleep(700);
        await tx.execute(sql`SELECT 1`);
      }),
    ).rejects.toThrow();
    const after = await execute(registry, adapter, ctx, "pool_guard.inner", {});
    expect(after.ok).toBe(true);
  });
});
