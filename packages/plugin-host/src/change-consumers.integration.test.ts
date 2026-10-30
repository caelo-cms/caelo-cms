// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 — plugins consume the change journal (rule 8 of
 * docs/dev/state-and-changes.md), end to end against real Postgres:
 *
 * - first sight of a consumer runs its rebuild; then committed changes of
 *   its declared kinds arrive, at least once, per branch in that branch's
 *   scope (so the plugin's own writes land where the change is);
 * - its own storage arrives as `own`, another plugin's storage never;
 * - a dispatch that fails leaves the batch uncommitted, and it arrives
 *   again;
 * - the journal's NOTIFY wakes the loop without anyone calling drain;
 * - consuming core kinds without the `cms_admin` read grant is refused at
 *   registration, and so is a consumer without `change_journal`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { registerAdminOps } from "@caelo-cms/admin-core";
import {
  definePlugin,
  type PluginAdminQuery,
  type PluginChange,
  type PluginChangesArgs,
} from "@caelo-cms/plugin-sdk";
import {
  beginConsumerRebuild,
  claimConsumer,
  commitChanges,
  DatabaseAdapter,
  execute,
  finishConsumerRebuild,
  OperationRegistry,
  pollChanges,
  releaseConsumer,
} from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import {
  bootstrap,
  changeConsumerName,
  drainChangeConsumers,
  loadedPlugins,
  type PluginHostInfra,
  resetPluginHost,
  runPluginOperation,
  startChangeConsumers,
} from "./index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t1267c",
};
const PFX = "t1267c-";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let infra: PluginHostInfra;

interface Received {
  readonly chatBranchId: string | null;
  readonly invocationBranch: string | null;
  readonly changes: readonly PluginChange[];
}
const received: Received[] = [];
let rebuilds = 0;
let failNext = false;
/** Runs inside the rebuild while it reads its source (a concurrent write). */
let duringRebuild: (() => Promise<void>) | null = null;
let failRebuild = false;
/** Runs inside a dispatch (a slow plugin operation). */
let duringDispatch: (() => Promise<void>) | null = null;

type AdminCtx = {
  adminQuery?: PluginAdminQuery;
  invocation: { chatBranchId?: string };
};

const consumer = definePlugin({
  slug: "t1267c-listener",
  version: "0.1.0",
  tier: 1,
  schema: {},
  adminSchema: { notes: { body: "text" } },
  requestedCapabilities: ["cms_admin", "cms_admin_schema", "change_journal"],
  changeConsumer: {
    operationName: "on_changes",
    rebuildOperationName: "rebuild",
    kinds: ["module"],
    ownTables: ["notes"],
    lines: "all",
  },
  operations: {
    on_changes: async (ctx, args) => {
      if (failNext) {
        failNext = false;
        throw new Error("the consumer failed this once");
      }
      if (duringDispatch) {
        const hook = duringDispatch;
        duringDispatch = null;
        await hook();
      }
      const a = args as PluginChangesArgs;
      received.push({
        chatBranchId: a.chatBranchId,
        invocationBranch: (ctx as AdminCtx).invocation.chatBranchId ?? null,
        changes: a.changes,
      });
      return { seen: a.changes.length };
    },
    rebuild: async () => {
      rebuilds += 1;
      if (failRebuild) {
        failRebuild = false;
        throw new Error("the rebuild failed this once");
      }
      if (duringRebuild) await duringRebuild();
      return {};
    },
    add_note: async (ctx, args) => {
      const q = (ctx as AdminCtx).adminQuery;
      if (!q) throw new Error("ctx.adminQuery missing");
      return q.insert("notes", { body: (args as { body: string }).body });
    },
  },
});

/** Another plugin with a table of the same name: its rows must never reach the listener. */
const neighbour = definePlugin({
  slug: "t1267c-neighbour",
  version: "0.1.0",
  tier: 1,
  schema: {},
  adminSchema: { notes: { body: "text" } },
  requestedCapabilities: ["cms_admin_schema"],
  operations: {
    add_note: async (ctx, args) => {
      const q = (ctx as AdminCtx).adminQuery;
      if (!q) throw new Error("ctx.adminQuery missing");
      return q.insert("notes", { body: (args as { body: string }).body });
    },
  },
});

async function withSystemSql<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  await withSystemSql(async (tx) => {
    await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_t1267c_listener" CASCADE');
    await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_t1267c_neighbour" CASCADE');
    await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't1267c-%'))`);
    await tx.unsafe(`DELETE FROM site_snapshots WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't1267c-%'))`);
    await tx.unsafe(
      "DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't1267c-%')",
    );
    await tx.unsafe("DELETE FROM plugins WHERE slug LIKE 't1267c-%'");
  });
}

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

function listenerId(): string {
  const id = loadedPlugins.bySlug("t1267c-listener")?.pluginId;
  if (!id) throw new Error("listener not loaded");
  return id;
}

async function drain(): Promise<void> {
  const reports = await drainChangeConsumers(infra);
  for (const r of reports) if (r.error) throw new Error(`${r.slug}: ${r.error}`);
}

async function note(slug: string, body: string): Promise<string> {
  const r = await runPluginOperation({
    invocation: { origin: "system", actorId: SYSTEM_ACTOR_ID },
    pluginSlug: slug,
    operationName: "add_note",
    args: { body },
  });
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return (r.value as { id: string }).id;
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
    testPlugins: [{ definition: consumer }, { definition: neighbour }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

describe("#1267 — a plugin's change consumer", () => {
  it("rebuilds on first sight, then receives committed changes of its kinds, per branch", async () => {
    await drain();
    expect(rebuilds).toBe(1);
    received.length = 0;

    const live = await op<{ moduleId: string }>(SYS, "modules.create", {
      slug: `${PFX}live`,
      displayName: "Live",
      html: "<p>live</p>",
    });
    const session = await op<{ chatSessionId: string; chatBranchId: string }>(
      SYS,
      "chat.create_session",
      { title: `${PFX}branch` },
    );
    await op(
      { ...SYS, chatBranchId: session.chatBranchId, chatTaskId: session.chatSessionId },
      "modules.update",
      { moduleId: live.moduleId, html: "<p>draft</p>" },
    );
    await drain();
    expect(rebuilds).toBe(1);

    const main = received.find((r) => r.chatBranchId === null);
    expect(main?.invocationBranch).toBeNull();
    expect(main?.changes.some((c) => c.kind === "module" && c.rowId === live.moduleId)).toBe(true);
    const draft = received.find((r) => r.chatBranchId === session.chatBranchId);
    // The batch runs in the branch's scope: the plugin's writes land there.
    expect(draft?.invocationBranch).toBe(session.chatBranchId);
    // The draft snapshot names the state it replaced (main's), to diff.
    const draftChange = draft?.changes.find((c) => c.rowId === live.moduleId);
    const mainSnapshot = main?.changes.find(
      (c) => c.rowId === live.moduleId && c.siteSnapshotId !== null,
    );
    expect(draftChange?.siteSnapshotId).not.toBeNull();
    expect(draftChange?.prevSnapshotId).toBe(mainSnapshot?.siteSnapshotId ?? "missing");

    received.length = 0;
    await drain();
    expect(received).toEqual([]);
  });

  it("receives its own storage as `own`, never another plugin's", async () => {
    await drain();
    received.length = 0;
    const mine = await note("t1267c-listener", "mine");
    const theirs = await note("t1267c-neighbour", "theirs");
    await drain();
    const all = received.flatMap((r) => r.changes);
    // The live row and the row snapshot its write recorded — both its own.
    expect(new Set(all.map((c) => `${c.kind}:${c.table}:${c.op}:${c.rowId}`))).toEqual(
      new Set([`own:notes:insert:${mine}`]),
    );
    expect(all.some((c) => c.rowId === theirs)).toBe(false);
  });

  it("re-delivers a batch whose dispatch failed", async () => {
    received.length = 0;
    const m = await op<{ moduleId: string }>(SYS, "modules.create", {
      slug: `${PFX}retry`,
      displayName: "Retry",
      html: "<p>retry</p>",
    });
    failNext = true;
    const failed = await drainChangeConsumers(infra);
    expect(failed.find((r) => r.slug === "t1267c-listener")?.error).toContain("failed this once");
    expect(received).toEqual([]);
    await drain();
    expect(received.flatMap((r) => r.changes).some((c) => c.rowId === m.moduleId)).toBe(true);
  });

  it("delivers a change committed while the rebuild ran, and retries a failed rebuild", async () => {
    await drain();
    const name = changeConsumerName(listenerId());
    // A rebuild is due (as after a cursor fell behind the horizon).
    await adapter.withAdminTransaction(SYS, (tx) => beginConsumerRebuild(tx, name));
    received.length = 0;
    let written = "";
    duringRebuild = async () => {
      duringRebuild = null;
      written = (
        await op<{ moduleId: string }>(SYS, "modules.create", {
          slug: `${PFX}during-rebuild`,
          displayName: "During rebuild",
          html: "<p>written while the rebuild read</p>",
        })
      ).moduleId;
    };
    const before = rebuilds;
    await drain();
    expect(rebuilds).toBe(before + 1);
    // The rebuild may have read it or not: either way it is delivered.
    expect(received.flatMap((r) => r.changes).some((c) => c.rowId === written)).toBe(true);

    // A rebuild that fails stays pending and runs on the next drain.
    await adapter.withAdminTransaction(SYS, (tx) => beginConsumerRebuild(tx, name));
    failRebuild = true;
    const failed = await drainChangeConsumers(infra);
    expect(failed.find((r) => r.slug === "t1267c-listener")?.error).toContain("rebuild failed");
    const retried = await drainChangeConsumers(infra);
    expect(retried.find((r) => r.slug === "t1267c-listener")?.rebuilt).toBe(true);
  });

  it("drains a burst larger than its batch budget without waiting for another write", async () => {
    await drain();
    received.length = 0;
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(
        (
          await op<{ moduleId: string }>(SYS, "modules.create", {
            slug: `${PFX}burst-${i}`,
            displayName: `Burst ${i}`,
            html: `<p>burst ${i}</p>`,
          })
        ).moduleId,
      );
    }
    // A budget of one 2-row batch per drain: one wake-up must still deliver
    // all of it, because a consumer with changes left is drained again.
    const loop = await startChangeConsumers(infra, { batchSize: 2, maxBatches: 1 });
    try {
      await loop.drain();
    } finally {
      await loop.stop();
    }
    const seen = new Set(received.flatMap((r) => r.changes).map((c) => c.rowId));
    for (const id of ids) expect(seen.has(id)).toBe(true);
    const budgeted = await drainChangeConsumers(infra, "t1267c-listener", {
      batchSize: 2,
      maxBatches: 1,
    });
    expect(budgeted[0]?.more).toBe(false);
  });

  it("keeps its claim through a dispatch longer than the claim, and a lapsed claim commits nothing", async () => {
    await drain();
    const name = changeConsumerName(listenerId());
    await op(SYS, "modules.create", {
      slug: `${PFX}slow`,
      displayName: "Slow",
      html: "<p>slow</p>",
    });
    let stolen: boolean | null = null;
    duringDispatch = async () => {
      // Longer than the 1 s claim: the drain renews it meanwhile.
      await Bun.sleep(2_200);
      stolen = await adapter.withAdminTransaction(SYS, (tx) =>
        claimConsumer(tx, name, "another-instance", 1_000),
      );
    };
    const reports = await drainChangeConsumers(infra, "t1267c-listener", { claimMs: 1_000 });
    expect(stolen).toBe(false);
    expect(reports[0]?.error).toBeUndefined();

    // The fence: a holder whose claim lapsed and was taken over commits
    // nothing and cannot finish a rebuild.
    await op(SYS, "modules.create", {
      slug: `${PFX}fenced`,
      displayName: "Fenced",
      html: "<p>fenced</p>",
    });
    const batch = await adapter.withAdminTransaction(SYS, async (tx) => {
      expect(await claimConsumer(tx, name, "instance-a", 1_000)).toBe(true);
      return pollChanges(tx, name, { filter: { kinds: ["module"] }, limit: 100 });
    });
    await Bun.sleep(1_100);
    await adapter.withAdminTransaction(SYS, async (tx) => {
      expect(await claimConsumer(tx, name, "instance-b", 1_000)).toBe(true);
    });
    await expect(
      adapter.withAdminTransaction(SYS, (tx) =>
        commitChanges(tx, name, batch.token, { holder: "instance-a" }),
      ),
    ).rejects.toThrow(/claim lapsed/);
    await expect(
      adapter.withAdminTransaction(SYS, (tx) =>
        finishConsumerRebuild(tx, name, { holder: "instance-a" }),
      ),
    ).rejects.toThrow(/claim lapsed or was taken over/);
    await adapter.withAdminTransaction(SYS, (tx) => releaseConsumer(tx, name, "instance-b"));
    // Nothing was lost: the batch arrives on the next drain.
    received.length = 0;
    await drain();
    expect(received.flatMap((r) => r.changes).length).toBeGreaterThan(0);
  }, 30_000);

  it("takes over from a holder that died mid-batch without any new write", async () => {
    await drain();
    const name = changeConsumerName(listenerId());
    const m = await op<{ moduleId: string }>(SYS, "modules.create", {
      slug: `${PFX}orphaned`,
      displayName: "Orphaned",
      html: "<p>orphaned</p>",
    });
    // Another instance claimed the consumer, polled the batch and died: its
    // claim lapses in a second and nothing will notify about that.
    await adapter.withAdminTransaction(SYS, async (tx) => {
      expect(await claimConsumer(tx, name, "dead-instance", 1_000)).toBe(true);
      await pollChanges(tx, name, { filter: { kinds: ["module"] }, limit: 100 });
    });
    received.length = 0;
    const loop = await startChangeConsumers(infra);
    try {
      // The wake-up of the LISTEN connection finds the claim held and skips.
      await loop.drain();
      expect(received.flatMap((r) => r.changes).some((c) => c.rowId === m.moduleId)).toBe(false);
      const deadline = Date.now() + 10_000;
      while (
        !received.flatMap((r) => r.changes).some((c) => c.rowId === m.moduleId) &&
        Date.now() < deadline
      ) {
        await Bun.sleep(50);
      }
      expect(received.flatMap((r) => r.changes).some((c) => c.rowId === m.moduleId)).toBe(true);
    } finally {
      await loop.stop();
    }
  }, 20_000);

  it("is woken by the journal's NOTIFY", async () => {
    const loop = await startChangeConsumers(infra);
    try {
      await loop.drain();
      received.length = 0;
      const m = await op<{ moduleId: string }>(SYS, "modules.create", {
        slug: `${PFX}woken`,
        displayName: "Woken",
        html: "<p>woken</p>",
      });
      const deadline = Date.now() + 10_000;
      while (
        !received.flatMap((r) => r.changes).some((c) => c.rowId === m.moduleId) &&
        Date.now() < deadline
      ) {
        await Bun.sleep(25);
      }
      expect(received.flatMap((r) => r.changes).some((c) => c.rowId === m.moduleId)).toBe(true);
    } finally {
      await loop.stop();
    }
  });

  it("refuses a consumer of core kinds without the cms_admin read grant", async () => {
    const report = await bootstrap({
      infra,
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [
        {
          definition: definePlugin({
            slug: "t1267c-ungranted",
            version: "0.1.0",
            tier: 1,
            schema: {},
            requestedCapabilities: ["change_journal"],
            changeConsumer: {
              operationName: "on_changes",
              rebuildOperationName: "on_changes",
              kinds: ["page"],
              lines: "main",
            },
            operations: { on_changes: async () => ({}) },
          }),
        },
      ],
    });
    expect(report.loaded).toEqual([]);
    expect(report.failed[0]?.reason).toContain("cms_admin");
  });
});
