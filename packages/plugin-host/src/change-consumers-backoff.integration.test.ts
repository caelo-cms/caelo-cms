// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1390 — a failing change consumer backs off, and the backoff holds
 * against the journal's NOTIFY wake-ups, end to end against real Postgres.
 *
 * Regression for searchVIU production, 2026-11-03: the consent-manager's
 * consumer ran a site-sized core read for every agent write's batch; each
 * hit the 60 s statement timeout, and the next write's NOTIFY re-ran the
 * same failing batch at once. Here a consumer that reads core data and then
 * fails is woken by a stream of writes:
 *
 * - it is not re-run before its backoff ends, however many writes arrive;
 * - a healthy consumer next to it receives every write meanwhile;
 * - its batch stayed uncommitted, so it is retried when the backoff ends
 *   (by the timer, with no write) and delivers everything; success resets
 *   the backoff, so the next write reaches it at once;
 * - plugin health (`plugins.get`) shows the backoff and the time of the
 *   core operations it called, written with the runtime heartbeat.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { definePlugin, type PluginChangesArgs, type PluginCms } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { bootstrap, type PluginHostInfra, resetPluginHost, startChangeConsumers } from "./index.js";
import { runtimeHeartbeatOnce } from "./runtime-health.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: "t1390" };
const PFX = "t1390b-";
/** Long enough that a stream of writes falls inside it, short enough for CI. */
const BACKOFF_MS = 4_000;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let infra: PluginHostInfra;

let failing = true;
/** Every dispatch of the failing consumer's batch operation, with when it ran. */
const failingAttempts: number[] = [];
const failingReceived = new Set<string>();
const healthyReceived = new Set<string>();

const failingConsumer = definePlugin({
  slug: "t1390b-failing",
  version: "0.1.0",
  tier: 1,
  schema: {},
  requestedCapabilities: ["cms_admin", "change_journal"],
  changeConsumer: {
    operationName: "on_changes",
    rebuildOperationName: "rebuild",
    kinds: ["module"],
    lines: "main",
  },
  operations: {
    on_changes: async (ctx, args) => {
      const a = args as PluginChangesArgs;
      failingAttempts.push(Date.now());
      // Like the production consumer: a core read for the batch first.
      const cms = (ctx as { cms?: PluginCms }).cms;
      if (!cms) throw new Error("ctx.cms missing");
      await cms.call("modules.list", { moduleIds: a.changes.map((c) => c.rowId).slice(0, 1000) });
      if (failing) throw new Error("canceling statement due to statement timeout");
      for (const c of a.changes) failingReceived.add(c.rowId);
      return {};
    },
    rebuild: async () => ({}),
  },
});

const healthyConsumer = definePlugin({
  slug: "t1390b-healthy",
  version: "0.1.0",
  tier: 1,
  schema: {},
  requestedCapabilities: ["cms_admin", "change_journal"],
  changeConsumer: {
    operationName: "on_changes",
    rebuildOperationName: "rebuild",
    kinds: ["module"],
    lines: "main",
  },
  operations: {
    on_changes: async (_ctx, args) => {
      for (const c of (args as PluginChangesArgs).changes) healthyReceived.add(c.rowId);
      return {};
    },
    rebuild: async () => ({}),
  },
});

async function cleanup(): Promise<void> {
  resetPluginHost();
  const sql = new SQL(ADMIN_URL);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const plugins = "SELECT id FROM plugins WHERE slug LIKE 't1390b-%'";
      const actors = `SELECT id FROM actors WHERE plugin_id IN (${plugins})`;
      await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (${actors})`);
      await tx.unsafe(`DELETE FROM site_snapshots WHERE actor_id IN (${actors})`);
      await tx.unsafe(`DELETE FROM actors WHERE plugin_id IN (${plugins})`);
      await tx.unsafe("DELETE FROM plugin_runtime WHERE plugin_slug LIKE 't1390b-%'");
      await tx.unsafe("DELETE FROM plugin_errors WHERE plugin_slug LIKE 't1390b-%'");
      await tx.unsafe("DELETE FROM plugins WHERE slug LIKE 't1390b-%'");
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

let n = 0;
async function writeModule(): Promise<string> {
  n += 1;
  const m = await op<{ moduleId: string }>("modules.create", {
    slug: `${PFX}m${n}-${Date.now()}`,
    displayName: `Backoff ${n}`,
    html: `<p>${n}</p>`,
  });
  return m.moduleId;
}

async function until(what: string, cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(25);
  }
}

interface HealthOut {
  plugin: {
    health: {
      consumerBackoff: {
        consecutiveFailures: number;
        nextRetryAt: string;
        lastError: string;
      } | null;
      callCost: {
        since: string | null;
        calls: number;
        totalMs: number;
        ops: { op: string; calls: number; totalMs: number; maxMs: number }[];
      };
    };
  } | null;
}

async function healthOf(slug: string) {
  await runtimeHeartbeatOnce(infra, SYSTEM_ACTOR_ID);
  const out = await op<HealthOut>("plugins.get", { slug });
  if (!out.plugin) throw new Error(`plugin ${slug} missing`);
  return out.plugin.health;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  infra = { adapter, registry };
  await cleanup();
  const report = await bootstrap({
    infra,
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: failingConsumer }, { definition: healthyConsumer }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

describe("#1390 — a failing change consumer backs off against NOTIFY wake-ups", () => {
  it("is not re-run by writes before its backoff ends, is retried after, and leaves its neighbour alone", async () => {
    const loop = await startChangeConsumers(infra, {
      failureRetryMinMs: BACKOFF_MS,
      failureRetryMaxMs: BACKOFF_MS * 4,
    });
    try {
      // First sight: both rebuild; nothing is pending yet.
      await loop.drain();
      failingAttempts.length = 0;

      const first = await writeModule();
      await until("the failing consumer's first attempt", () => failingAttempts.length === 1);
      const failedAt = failingAttempts[0] ?? 0;
      await until("the healthy consumer gets the first write", () => healthyReceived.has(first));

      // A stream of agent writes inside the backoff: each NOTIFY wakes the
      // loop; the healthy consumer drains every one, the failing one none.
      const during: string[] = [];
      while (Date.now() - failedAt < BACKOFF_MS - 1_500) {
        const id = await writeModule();
        during.push(id);
        await until("the healthy consumer gets a write in the backoff", () =>
          healthyReceived.has(id),
        );
        await Bun.sleep(150);
      }
      expect(during.length).toBeGreaterThanOrEqual(3);
      expect(failingAttempts.length).toBe(1);

      // Health shows the backoff and what its core read cost.
      const backingOff = await healthOf("t1390b-failing");
      expect(backingOff.consumerBackoff?.consecutiveFailures).toBe(1);
      expect(backingOff.consumerBackoff?.lastError).toContain("statement timeout");
      const retryAt = Date.parse(backingOff.consumerBackoff?.nextRetryAt ?? "");
      expect(retryAt - failedAt).toBeGreaterThanOrEqual(BACKOFF_MS - 100);
      const list = backingOff.callCost.ops.find((o) => o.op === "modules.list");
      expect(list?.calls).toBe(1);
      expect(backingOff.callCost.calls).toBeGreaterThanOrEqual(1);
      expect(backingOff.callCost.since).not.toBeNull();
      // The healthy neighbour has no backoff.
      expect((await healthOf("t1390b-healthy")).consumerBackoff).toBeNull();

      // The cause goes away. No further write: the timer retries the batch
      // once the backoff ends, and it was never committed, so everything
      // written meanwhile arrives.
      failing = false;
      await until(
        "the retry delivers the uncommitted batch",
        () => [first, ...during].every((id) => failingReceived.has(id)),
        BACKOFF_MS * 3,
      );
      expect(failingAttempts.length).toBe(2);
      expect((failingAttempts[1] ?? 0) - failedAt).toBeGreaterThanOrEqual(BACKOFF_MS - 100);

      // Success reset the backoff: the next write reaches it at once.
      const after = await writeModule();
      const writtenAt = Date.now();
      await until("a write after recovery", () => failingReceived.has(after), 3_000);
      expect(Date.now() - writtenAt).toBeLessThan(BACKOFF_MS);
      const recovered = await healthOf("t1390b-failing");
      expect(recovered.consumerBackoff).toBeNull();
      expect(recovered.callCost.ops.find((o) => o.op === "modules.list")?.calls).toBe(3);
    } finally {
      await loop.stop();
    }
  }, 60_000);

  it("doubles the backoff on consecutive failures", async () => {
    failing = true;
    failingAttempts.length = 0;
    const loop = await startChangeConsumers(infra, {
      failureRetryMinMs: 1_000,
      failureRetryMaxMs: 60_000,
    });
    try {
      await loop.drain();
      await writeModule();
      // An attempt is counted when the operation starts; its failure is
      // recorded after it throws — wait for the second recorded failure.
      let health = await healthOf("t1390b-failing");
      const deadline = Date.now() + 10_000;
      while ((health.consumerBackoff?.consecutiveFailures ?? 0) < 2) {
        if (Date.now() > deadline) throw new Error("timed out waiting for two recorded failures");
        await Bun.sleep(50);
        health = await healthOf("t1390b-failing");
      }
      expect(health.consumerBackoff?.consecutiveFailures).toBe(2);
      expect(failingAttempts.length).toBe(2);
      const [a, b] = failingAttempts;
      // 1 s after the first failure; the next waits 2 s.
      expect((b ?? 0) - (a ?? 0)).toBeGreaterThanOrEqual(900);
      const nextRetry = Date.parse(health.consumerBackoff?.nextRetryAt ?? "");
      expect(nextRetry - (b ?? 0)).toBeGreaterThanOrEqual(1_900);
    } finally {
      failing = false;
      await loop.stop();
    }
  }, 30_000);
});
