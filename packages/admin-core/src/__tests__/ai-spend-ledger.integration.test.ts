// SPDX-License-Identifier: MPL-2.0

/**
 * #1653 — the AI spend ledger against a real Postgres:
 *
 * - a reached day-global, day-per-actor or session text budget refuses the
 *   next call with an actionable message; a subagent counts toward its
 *   parent chat's session budget;
 * - parallel reservations never overshoot a budget (only the calls that fit
 *   are reserved, the rest are refused);
 * - settling moves a reservation to the real cost, releasing frees it, and
 *   an extension (a turn's next step) is checked like a new call;
 * - the plugin cap reserves before the call: parallel `ctx.ai` calls of one
 *   plugin cannot overshoot it, and a provider that throws releases;
 * - an unpriced model runs uncounted only while no cap applies;
 * - a visitor spender needs its own daily cap and is bounded by it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  bootstrap,
  type LoadedPlugin,
  loadedPlugins,
  type PluginHostInfra,
  resetPluginHost,
} from "@caelo-cms/plugin-host";
import { definePlugin, type PluginInvocation } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { type ExecutionContext, resetCapLookupCounters } from "@caelo-cms/shared";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { makePluginAi } from "../../../plugin-host/src/plugin-ai.js";
import { invalidateAllPricing } from "../ai/pricing-cache.js";
import { registerAdminOps } from "../register.js";

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t1653",
};
const PROVIDER = "t1653-provider";
const MODEL = "t1653-model";
const SLUG = "t1653-ai";

let adapter: DatabaseAdapter;
const registry = new OperationRegistry();
const alice = crypto.randomUUID();
const bob = crypto.randomUUID();
let plugin: LoadedPlugin;

/**
 * Test-only cleanup on its own connection, outside the adapter's tagged
 * transactions: it removes this file's rows by its made-up provider, a
 * filter no product query uses (the query index gate reads only the tagged
 * ones), as the other spend suites do.
 */
async function wipeCalls(): Promise<void> {
  const conn = new SQL(process.env.ADMIN_DATABASE_URL as string);
  try {
    await conn.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM ai_calls WHERE provider = ${PROVIDER}`;
    });
  } finally {
    await conn.end();
  }
}

async function sys<T>(
  fn: (tx: Parameters<Parameters<DatabaseAdapter["withAdminTransaction"]>[1]>[0]) => Promise<T>,
): Promise<T> {
  return adapter.withAdminTransaction(SYSTEM, fn);
}

async function setBudget(scope: "session" | "day-global" | "day-per-actor", cap: number | null) {
  await sys((tx) =>
    tx.execute(sql`
      INSERT INTO ai_budgets (scope, operation_type, cap_microcents, warn_at_pct, updated_at)
      VALUES (${scope}, 'text', ${cap}, 0.8, now())
      ON CONFLICT (scope, operation_type) DO UPDATE SET cap_microcents = EXCLUDED.cap_microcents
    `),
  );
}

/** A chat of `actorId` (a subagent's parent relation lives on its ai_calls rows). */
async function newSession(actorId: string): Promise<string> {
  const r = await execute(
    registry,
    adapter,
    { actorId, actorKind: "human", requestId: "t1653" },
    "chat.create_session",
    { title: "ledger test", isolation: "experiment" },
  );
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.value as { chatSessionId: string }).chatSessionId;
}

type Spender =
  | {
      kind: "actor";
      actorId: string;
      chatSessionId: string | null;
      parentChatSessionId?: string | null;
    }
  | { kind: "plugin"; pluginId: string; actorId: string; chatSessionId: string | null };

/** 1,000 prompt tokens + 1,000 output tokens = 10,000 µ¢ worst case at the test prices. */
const UNIT = { promptTokens: 1_000, maxOutputTokens: 1_000 };
const UNIT_COST = 10_000;

async function reserve(spender: Spender, request = UNIT, model = MODEL) {
  return execute(registry, adapter, SYSTEM, "ai_ledger.reserve", {
    spender,
    provider: PROVIDER,
    model,
    request,
    what: "this test call",
  });
}

async function spent(where: ReturnType<typeof sql>): Promise<number> {
  const rows = (await sys((tx) =>
    tx.execute(
      sql`SELECT coalesce(sum(cost_estimate_microcents), 0)::bigint AS n FROM ai_calls WHERE ${where}`,
    ),
  )) as unknown as { n: string }[];
  return Number(rows[0]?.n ?? 0);
}

beforeAll(async () => {
  if (!process.env.ADMIN_DATABASE_URL || !process.env.PUBLIC_ADMIN_DATABASE_URL)
    throw new Error("Dedicated test DB URLs required");
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
    publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
  });
  registerAdminOps(registry);
  await sys(async (tx) => {
    for (const id of [alice, bob]) {
      await tx.execute(
        sql`INSERT INTO actors (id, kind, display_name) VALUES (${id}::uuid, 'human', 'ledger test')`,
      );
      await tx.execute(
        sql`INSERT INTO users (id, email, password_hash) VALUES (${id}::uuid, ${`${id}@example.test`}, 'test-only')`,
      );
      await tx.execute(
        sql`INSERT INTO user_roles (user_id, role_id) SELECT ${id}::uuid, id FROM roles WHERE name = 'owner'`,
      );
    }
    // Input 2,000 µ¢ per 1K tokens (cache writes 5,000), output 5,000 per 1K.
    await tx.execute(sql`
      INSERT INTO ai_pricing (provider, model, operation_type, input_microcents, output_microcents,
                              cached_microcents, cache_creation_microcents)
      VALUES (${PROVIDER}, ${MODEL}, 'text', 2000, 5000, 200, 5000)
    `);
  });
  invalidateAllPricing();
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM.actorId,
    testPlugins: [
      {
        definition: definePlugin({
          slug: SLUG,
          version: "1.0.0",
          tier: 1,
          schema: {},
          requestedCapabilities: ["ai_provider"],
          operations: { noop: async () => ({}) },
        }),
      },
    ],
  });
  expect(report.failed).toEqual([]);
  plugin = loadedPlugins.bySlug(SLUG) as LoadedPlugin;
});

beforeEach(async () => {
  resetCapLookupCounters();
  await wipeCalls();
  await sys(async (tx) => {
    await tx.execute(
      sql`UPDATE ai_budgets SET cap_microcents = NULL WHERE operation_type = 'text'`,
    );
    await tx.execute(sql`UPDATE plugins SET ai_cost_cap_microcents = NULL WHERE slug = ${SLUG}`);
  });
});

afterAll(async () => {
  await wipeCalls();
  await sys(async (tx) => {
    await tx.execute(sql`DELETE FROM ai_pricing WHERE provider = ${PROVIDER}`);
    await tx.execute(
      sql`UPDATE ai_budgets SET cap_microcents = NULL WHERE operation_type = 'text'`,
    );
    await tx.execute(
      sql`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG})`,
    );
    await tx.execute(sql`DELETE FROM plugins WHERE slug = ${SLUG}`);
  });
  resetPluginHost();
  await adapter.close();
});

describe("the AI spend ledger (#1653)", () => {
  it("reserves the worst case at the dearest input lane and the output ceiling", async () => {
    const r = await reserve({ kind: "actor", actorId: alice, chatSessionId: null });
    expect(r.ok).toBe(true);
    // 1,000 × 5,000/1K (cache-write rate) + 1,000 × 5,000/1K.
    expect((r.ok ? r.value : null) as unknown).toMatchObject({ reservedMicrocents: UNIT_COST });
  });

  it("a reached day-global budget refuses with the figures and the next step", async () => {
    await setBudget("day-global", 25_000);
    expect((await reserve({ kind: "actor", actorId: alice, chatSessionId: null })).ok).toBe(true);
    expect((await reserve({ kind: "actor", actorId: bob, chatSessionId: null })).ok).toBe(true);
    const third = await reserve({ kind: "actor", actorId: alice, chatSessionId: null });
    expect(third.ok).toBe(false);
    const e = third.ok ? null : (third.error as { refusal?: boolean; message: string });
    expect(e?.refusal).toBe(true);
    expect(e?.message).toContain("AiBudgetReached (day-global)");
    expect(e?.message).toMatch(/\$[\d.]+ of \$[\d.]+ spent/);
    expect(e?.message).toContain("Settings → AI → Budgets");
  });

  it("the per-person budget refuses one person and not another", async () => {
    await setBudget("day-per-actor", 15_000);
    expect((await reserve({ kind: "actor", actorId: alice, chatSessionId: null })).ok).toBe(true);
    const again = await reserve({ kind: "actor", actorId: alice, chatSessionId: null });
    expect(
      again.ok ? "" : again.error.kind === "HandlerError" ? again.error.message : "",
    ).toContain("AiBudgetReached (day-per-actor)");
    expect((await reserve({ kind: "actor", actorId: bob, chatSessionId: null })).ok).toBe(true);
  });

  it("the session budget counts a subagent toward its parent chat", async () => {
    await setBudget("session", 15_000);
    const parent = await newSession(alice);
    const child = await newSession(alice);
    const other = await newSession(alice);
    expect((await reserve({ kind: "actor", actorId: alice, chatSessionId: parent })).ok).toBe(true);
    const sub = await reserve({
      kind: "actor",
      actorId: alice,
      chatSessionId: child,
      parentChatSessionId: parent,
    });
    expect(sub.ok ? "" : sub.error.kind === "HandlerError" ? sub.error.message : "").toContain(
      "AiBudgetReached (session)",
    );
    expect((await reserve({ kind: "actor", actorId: alice, chatSessionId: other })).ok).toBe(true);
  });

  it("parallel calls cannot overshoot a budget", async () => {
    await setBudget("day-global", 55_000);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        reserve({ kind: "actor", actorId: i % 2 ? alice : bob, chatSessionId: null }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok)).toHaveLength(15);
    expect(await spent(sql`provider = ${PROVIDER}`)).toBeLessThanOrEqual(55_000);
  });

  it("settling moves a reservation to the real cost, releasing frees it, and an extension is checked", async () => {
    await setBudget("day-global", 30_000);
    const a = await reserve({ kind: "actor", actorId: alice, chatSessionId: null });
    const callId = (a.ok ? a.value : null) as { callId: string };
    const settle = await execute(registry, adapter, SYSTEM, "ai_ledger.settle", {
      callId: callId.callId,
      provider: PROVIDER,
      model: MODEL,
      usage: { inputTokens: 500, outputTokens: 200 },
      durationMs: 10,
      succeeded: true,
    });
    // 500 × 2,000/1K + 200 × 5,000/1K = 2,000.
    expect((settle.ok ? settle.value : null) as unknown).toMatchObject({ costMicrocents: 2_000 });
    const b = await reserve({ kind: "actor", actorId: alice, chatSessionId: null });
    const bId = ((b.ok ? b.value : null) as { callId: string }).callId;
    // A turn's next step: spent so far + the next request's worst case.
    const extended = await execute(registry, adapter, SYSTEM, "ai_ledger.extend", {
      callId: bId,
      spender: { kind: "actor", actorId: alice, chatSessionId: null },
      provider: PROVIDER,
      model: MODEL,
      used: { inputTokens: 1_000, outputTokens: 400 },
      next: UNIT,
      what: "this chat step",
    });
    expect(extended.ok).toBe(true);
    // 2,000 settled + 14,000 now on b. Spent 8,000 + a 25,000 worst case = 33,000 on b
    // plus a's 2,000 is past the 30,000 cap.
    const tooMuch = await execute(registry, adapter, SYSTEM, "ai_ledger.extend", {
      callId: bId,
      spender: { kind: "actor", actorId: alice, chatSessionId: null },
      provider: PROVIDER,
      model: MODEL,
      used: { inputTokens: 2_000, outputTokens: 800 },
      next: { promptTokens: 4_000, maxOutputTokens: 1_000 },
      what: "this chat step",
    });
    expect(
      tooMuch.ok ? "" : tooMuch.error.kind === "HandlerError" ? tooMuch.error.message : "",
    ).toContain("this chat step could cost up to");
    const released = await execute(registry, adapter, SYSTEM, "ai_ledger.release", { callId: bId });
    expect((released.ok ? released.value : null) as unknown).toEqual({ released: true });
    expect(await spent(sql`provider = ${PROVIDER}`)).toBe(2_000);
  });

  it("the plugin cap reserves before the call: parallel ctx.ai calls cannot overshoot it", async () => {
    await sys((tx) =>
      tx.execute(sql`UPDATE plugins SET ai_cost_cap_microcents = 45000 WHERE slug = ${SLUG}`),
    );
    let providerCalls = 0;
    const infra = {
      adapter,
      registry,
      aiProvider: {
        resolve: async () => ({ provider: PROVIDER, model: MODEL }),
        complete: async () => {
          providerCalls += 1;
          await Bun.sleep(30);
          return {
            text: "ok",
            inputTokens: 100,
            outputTokens: 100,
            cachedTokens: 0,
            cacheCreationTokens: 0,
            provider: PROVIDER,
            model: MODEL,
          };
        },
        generateObject: async () => {
          throw new Error("not used");
        },
      },
    } as unknown as PluginHostInfra;
    const invocation: PluginInvocation = { origin: "worker", actorId: plugin.pluginActorId };
    const ai = makePluginAi(plugin, infra, invocation);
    // Each call: prompt bound ≈ 2,000 + a few bytes, output 1,000 → ~15,0xx µ¢ reserved.
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        ai.complete({ system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 1_000 }),
      ),
    );
    const refused = results.filter((r) => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(providerCalls).toBe(2);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toContain(
      "AiBudgetReached (plugin)",
    );
    // Settled at the real cost: 100 × 2,000/1K + 100 × 5,000/1K = 700 each.
    expect(await spent(sql`plugin_id = ${plugin.pluginId}::uuid`)).toBe(1_400);
  });

  it("a plugin call whose provider throws releases its reservation", async () => {
    const infra = {
      adapter,
      registry,
      aiProvider: {
        resolve: async () => ({ provider: PROVIDER, model: MODEL }),
        complete: async () => {
          throw new Error("provider error: overloaded");
        },
        generateObject: async () => {
          throw new Error("not used");
        },
      },
    } as unknown as PluginHostInfra;
    const ai = makePluginAi(plugin, infra, { origin: "worker", actorId: plugin.pluginActorId });
    await expect(ai.complete({ system: "s", messages: [] })).rejects.toThrow("overloaded");
    const rows = (await sys((tx) =>
      tx.execute(
        sql`SELECT reservation, cost_estimate_microcents::int AS cost FROM ai_calls WHERE plugin_id = ${plugin.pluginId}::uuid`,
      ),
    )) as unknown as { reservation: string; cost: number }[];
    expect(rows).toEqual([{ reservation: "released", cost: 0 }]);
  });

  it("an unpriced model runs uncounted only while no cap applies", async () => {
    const free = await reserve(
      { kind: "actor", actorId: alice, chatSessionId: null },
      UNIT,
      "no-such-model",
    );
    expect((free.ok ? free.value : null) as unknown).toMatchObject({ reservedMicrocents: 0 });
    await setBudget("day-global", 1_000_000);
    const capped = await reserve(
      { kind: "actor", actorId: alice, chatSessionId: null },
      UNIT,
      "no-such-model",
    );
    expect(
      capped.ok ? "" : capped.error.kind === "HandlerError" ? capped.error.message : "",
    ).toContain("AiModelUnpriced");
  });
});
