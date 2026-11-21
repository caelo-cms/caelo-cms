// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (R5, issue #1646) — plugin batches through the `plugin_batch`
 * reporting job, in-process (the self-hosted path; the Cloud Run job runs
 * the same job main with an HTTP transport):
 *
 * - a shipped plugin's `activation` batch runs once per version, not again
 *   when the plugin loads a second time;
 * - an `operator` batch reads its configuration and writes its collection
 *   through the admin, and its result is kept;
 * - a second start of a running batch is refused, a stopped run stays
 *   stopped, a batch without the operator trigger cannot be started, and a
 *   disabled plugin's batch neither starts nor is queued;
 * - the launcher gives up a run when no active plugin holds `batch_jobs`;
 * - the tick's backstop starts a queued run whose start was lost;
 * - an installed plugin's batch runs in the Deno sandbox: no network, no
 *   Deno namespace, no environment, no other plugin's data, no storage
 *   handle it was not granted — and its collection write still works.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateApprovedExternalPlugin,
  bootstrap,
  loadedPlugins,
  resetCollectionStores,
  resetPluginHost,
  setPluginDisabled,
} from "@caelo-cms/plugin-host";
import { definePlugin, type PluginBatchArgs, type PluginCollections } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import type { BatchRun } from "../plugin-batches/ops.js";
import { bootstrapPluginBatchTriggers } from "../plugin-batches/triggers.js";
import { registerAdminOps } from "../register.js";
import { runReportingJobBackstop } from "../reporting-jobs/backstop.js";
import { inProcessJobLauncher } from "../reporting-jobs/in-process.js";
import { setInProcessJobLauncher, startReportingJob } from "../reporting-jobs/launcher.js";

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t1646",
};
const owner = { ...SYSTEM, actorId: crypto.randomUUID(), actorKind: "human" as const };
const SHIPPED = "t1646-batch";

let adapter: DatabaseAdapter;
const registry = new OperationRegistry();
let root = "";
let releaseSlow: () => void = () => {};
const installed: { slug: string; pluginId: string }[] = [];
const envBefore: Record<string, string | undefined> = {};
let stopTriggers: () => void = () => {};

async function op<T>(name: string, input: unknown, actor: ExecutionContext = SYSTEM): Promise<T> {
  const r = await execute(registry, adapter, actor, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function refusal(name: string, input: unknown, actor: ExecutionContext = owner) {
  const r = await execute(registry, adapter, actor, name, input);
  if (r.ok) throw new Error(`${name} should have been refused`);
  return JSON.stringify(r.error);
}

async function runs(slug: string): Promise<BatchRun[]> {
  return (await op<{ runs: BatchRun[] }>("plugin_batches.list", { pluginSlug: slug, limit: 100 }))
    .runs;
}

async function settled(runId: string, timeoutMs = 30_000): Promise<BatchRun> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const { run } = await op<{ run: BatchRun | null }>("plugin_batches.get", { runId });
    if (run && !["queued", "running"].includes(run.state)) return run;
    if (Date.now() > until) throw new Error(`run ${runId} still ${run?.state}`);
    await Bun.sleep(50);
  }
}

async function until(test: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await test())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(50);
  }
}

const shipped = definePlugin({
  slug: SHIPPED,
  version: "1.0.0",
  tier: 1,
  schema: {},
  requestedCapabilities: ["batch_jobs", "collections"],
  config: {
    prefix: {
      type: "string",
      label: "Prefix",
      description: "Put before every title.",
      effect: "rebuild",
      default: "Doc",
      maxLength: 40,
    },
  },
  collections: {
    docs: {
      description: "Batch-built documents.",
      fields: { title: { kind: "text" } },
      maxDocuments: 1000,
      maxDocumentBytes: 10_000,
    },
  },
  batchOperations: [
    {
      operation: "rebuild",
      description: "Rebuilds the documents from the configuration.",
      triggers: ["activation", "operator"],
      maxRunSeconds: 60,
    },
    {
      operation: "slow",
      description: "Waits until the test lets it end.",
      triggers: ["operator"],
      maxRunSeconds: 60,
    },
    {
      operation: "after_stage",
      description: "Runs after every Stage.",
      triggers: ["stage"],
      maxRunSeconds: 60,
    },
  ],
  operations: {
    rebuild: async (ctx, args) => {
      const a = args as PluginBatchArgs;
      const prefix = String((await ctx.config?.get())?.prefix);
      const docs = (ctx as { collections?: PluginCollections }).collections?.docs;
      if (!docs) throw new Error("no collection handle");
      const n = Number(a.input.count ?? 3);
      await docs.upsert(
        Array.from({ length: n }, (_, i) => ({
          id: `d${i}`,
          lang: "en",
          values: { title: `${prefix} ${i}` },
        })),
      );
      return { count: n, trigger: a.trigger, invocation: ctx.invocation.origin };
    },
    slow: async () => {
      await new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
      return { done: true };
    },
    after_stage: async () => ({}),
  },
});

/** An installed (Tier 2) plugin whose batch probes the sandbox. */
function installedSource(slug: string): string {
  return `export default {slug:"${slug}",version:"1.0.0",tier:2,operations:{
    probe: async (ctx, args) => {
      let env = "readable";
      try { env = typeof globalThis.process?.env?.ADMIN_DATABASE_URL === "string" ? "leaked" : "none"; } catch (e) { env = "denied"; }
      let other = "readable";
      try { await ctx.query.list("t1646_other_rows"); } catch (e) { other = "refused"; }
      await ctx.collections.docs.upsert([{ id: "x", lang: "en", values: { title: "from the sandbox" } }]);
      return {
        env,
        other,
        adminQuery: typeof ctx.adminQuery,
        files: typeof ctx.privateFiles,
        trigger: args.trigger,
      };
    }
  }};`;
}

beforeAll(async () => {
  if (!process.env.ADMIN_DATABASE_URL || !process.env.PUBLIC_ADMIN_DATABASE_URL)
    throw new Error("Dedicated test DB URLs required");
  root = await mkdtemp(join(tmpdir(), "caelo-t1646-"));
  for (const [k, v] of Object.entries({
    CAELO_COLLECTIONS_STAGING_STORE: `file://${root}/staging`,
    CAELO_COLLECTIONS_LIVE_STORE: `file://${root}/live`,
  })) {
    envBefore[k] = process.env[k];
    process.env[k] = v;
  }
  resetCollectionStores();
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
    publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
  });
  registerAdminOps(registry);
  setInProcessJobLauncher((kind) => inProcessJobLauncher({ adapter, registry }, kind));
  await adapter.withAdminTransaction(SYSTEM, async (tx) => {
    await tx.execute(
      sql`INSERT INTO actors(id,kind,display_name) VALUES (${owner.actorId}::uuid,'human','Batch test')`,
    );
    await tx.execute(
      sql`INSERT INTO users(id,email,password_hash) VALUES (${owner.actorId}::uuid,${`${owner.actorId}@example.test`},'test-only')`,
    );
    await tx.execute(
      sql`INSERT INTO user_roles(user_id,role_id) SELECT ${owner.actorId}::uuid,id FROM roles WHERE name='owner'`,
    );
  });
  stopTriggers = bootstrapPluginBatchTriggers({ adapter, registry });
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: root,
    systemActorId: SYSTEM.actorId,
    testPlugins: [{ definition: shipped }],
  });
  expect(report.failed).toEqual([]);

  const slug = `t1646-sbx-${crypto.randomUUID().slice(0, 6)}`;
  const manifest = {
    slug,
    version: "1.0.0",
    tier: 2,
    schema: {},
    operations: ["probe"],
    requestedCapabilities: ["batch_jobs", "collections"],
    capabilityReasons: {
      batch_jobs: "Rebuild the documents outside the admin",
      collections: "Keep documents for a search",
    },
    collections: {
      docs: {
        description: "Documents.",
        fields: { title: { kind: "text" } },
        maxDocuments: 100,
        maxDocumentBytes: 10_000,
      },
    },
    batchOperations: [
      {
        operation: "probe",
        description: "Probes what the sandbox allows.",
        triggers: ["operator"],
        maxRunSeconds: 60,
      },
    ],
  };
  const staged = await op<{ installationId: string; pluginId: string; artifactDigest: string }>(
    "plugins.stage_installation",
    { manifest, source: installedSource(slug) },
  );
  installed.push({ slug, pluginId: staged.pluginId });
  const list = await op<{ installations: { id: string; currentStateDigest: string }[] }>(
    "plugins.list_installations",
    {},
  );
  await op(
    "plugins.approve_installation",
    {
      installationId: staged.installationId,
      artifactDigest: staged.artifactDigest,
      expectedStateDigest: list.installations.find((i) => i.id === staged.installationId)
        ?.currentStateDigest,
      capabilities: ["batch_jobs", "collections"],
    },
    owner,
  );
  expect(await activateApprovedExternalPlugin(staged.installationId)).toEqual({ loaded: true });
});

afterAll(async () => {
  stopTriggers();
  releaseSlow();
  resetPluginHost();
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetCollectionStores();
  await adapter.withAdminTransaction(SYSTEM, async (tx) => {
    for (const i of installed)
      await tx.execute(sql`DELETE FROM plugins WHERE id = ${i.pluginId}::uuid`);
    await tx.execute(sql`DELETE FROM plugins WHERE slug = ${SHIPPED}`);
    await tx.execute(sql`DELETE FROM user_roles WHERE user_id = ${owner.actorId}::uuid`);
    await tx.execute(sql`DELETE FROM users WHERE id = ${owner.actorId}::uuid`);
  });
  await adapter.close();
  await rm(root, { recursive: true, force: true });
});

describe("plugin batches (#1646)", () => {
  it("runs a shipped plugin's activation batch once per version", async () => {
    await until(async () => (await runs(SHIPPED)).some((r) => r.trigger === "activation"));
    const first = (await runs(SHIPPED)).find((r) => r.trigger === "activation") as BatchRun;
    const done = await settled(first.id);
    expect(done.state).toBe("completed");
    expect(done.result).toEqual({ count: 3, trigger: "activation", invocation: "batch" });
    // The plugin loads again (another instance's boot, a reload): no second run.
    resetPluginHost();
    await bootstrap({
      infra: { adapter, registry },
      pluginsRoot: root,
      systemActorId: SYSTEM.actorId,
      testPlugins: [{ definition: shipped }],
    });
    await Bun.sleep(300);
    expect((await runs(SHIPPED)).filter((r) => r.trigger === "activation")).toHaveLength(1);
    // The installed plugin lost its registration with the reset; load it again.
    for (const i of installed) {
      const row = await op<{ installations: { id: string; pluginId: string }[] }>(
        "plugins.list_installations",
        {},
      );
      const inst = row.installations.find((x) => x.pluginId === i.pluginId);
      if (inst) await activateApprovedExternalPlugin(inst.id);
    }
  });

  it("an operator batch reads its configuration, writes its collection through the admin and keeps its result", async () => {
    const { run } = await op<{ run: BatchRun }>(
      "plugin_batches.start",
      { pluginSlug: SHIPPED, operation: "rebuild", input: { count: 5 } },
      owner,
    );
    expect(run.trigger).toBe("operator");
    const done = await settled(run.id);
    expect(done.state).toBe("completed");
    expect(done.result).toMatchObject({ count: 5, trigger: "operator" });
    const changes = await adapter.withAdminTransaction(
      SYSTEM,
      async (tx) =>
        (await tx.execute(sql`
        SELECT count(*)::int AS n FROM collection_changes c JOIN plugins p ON p.id = c.plugin_id
        WHERE p.slug = ${SHIPPED} AND c.run_id IS NULL
      `)) as unknown as { n: number }[],
    );
    // The activation run's and this one's changes wait for the next Stage.
    expect(changes[0]?.n).toBe(2);
  });

  it("refuses a second start while it runs, keeps a stopped run stopped, and refuses a batch without the operator trigger", async () => {
    const { run } = await op<{ run: BatchRun }>(
      "plugin_batches.start",
      { pluginSlug: SHIPPED, operation: "slow" },
      owner,
    );
    await until(async () => (await settled(run.id, 50).catch(() => null)) === null);
    expect(
      await refusal("plugin_batches.start", { pluginSlug: SHIPPED, operation: "slow" }),
    ).toContain("already");
    expect(
      await refusal("plugin_batches.start", { pluginSlug: SHIPPED, operation: "after_stage" }),
    ).toContain("starts on its own");
    const stopped = await op<{ stopped: boolean }>("plugin_batches.stop", { runId: run.id }, owner);
    expect(stopped.stopped).toBe(true);
    releaseSlow();
    await Bun.sleep(300);
    const { run: after } = await op<{ run: BatchRun }>("plugin_batches.get", { runId: run.id });
    expect(after.state).toBe("stopped");
  });

  it("a disabled plugin's batch neither starts nor is queued, and the launcher gives up without a plugin that holds the grant", async () => {
    setPluginDisabled(SHIPPED, true);
    for (const i of installed) setPluginDisabled(i.slug, true);
    try {
      expect(
        await refusal("plugin_batches.start", { pluginSlug: SHIPPED, operation: "rebuild" }),
      ).toContain("disabled");
      const queued = await op<{ runId: string | null }>("plugin_batches.enqueue", {
        pluginId: loadedPlugins.bySlug(SHIPPED)?.pluginId,
        operation: "after_stage",
        trigger: "stage",
      });
      expect(queued.runId).toBeNull();
      // A run queued before the plugin was switched off: its job never starts.
      const runId = await adapter.withAdminTransaction(SYSTEM, async (tx) => {
        const rows = (await tx.execute(sql`
          INSERT INTO plugin_batch_runs (plugin_id, operation, plugin_version, trigger)
          SELECT id, 'after_stage', '1.0.0', 'stage' FROM plugins WHERE slug = ${SHIPPED}
          RETURNING id::text AS id
        `)) as unknown as { id: string }[];
        return rows[0]?.id as string;
      });
      const outcome = await startReportingJob({ adapter, registry }, "plugin_batch", runId);
      expect(outcome.outcome).toBe("given-up");
      expect((await settled(runId)).error).toContain(
        'no active plugin holds the "batch_jobs" capability',
      );
    } finally {
      setPluginDisabled(SHIPPED, false);
      for (const i of installed) setPluginDisabled(i.slug, false);
    }
  });

  it("the tick's backstop starts a queued run whose start was lost", async () => {
    const runId = await adapter.withAdminTransaction(SYSTEM, async (tx) => {
      const rows = (await tx.execute(sql`
        INSERT INTO plugin_batch_runs (plugin_id, operation, plugin_version, trigger, input, created_at)
        SELECT id, 'rebuild', '1.0.0', 'operator', '{"count": 1}'::jsonb, now() - interval '5 minutes'
        FROM plugins WHERE slug = ${SHIPPED}
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      return rows[0]?.id as string;
    });
    await runReportingJobBackstop({ adapter, registry });
    const done = await settled(runId);
    expect(done.state).toBe("completed");
    expect(done.result).toMatchObject({ count: 1 });
  });

  it("an installed batch that reaches for the network or Deno is refused before it is installed", async () => {
    const slug = `t1646-net-${crypto.randomUUID().slice(0, 6)}`;
    const r = await execute(registry, adapter, SYSTEM, "plugins.stage_installation", {
      manifest: {
        slug,
        version: "1.0.0",
        tier: 2,
        schema: {},
        operations: ["probe"],
        requestedCapabilities: ["batch_jobs"],
        capabilityReasons: { batch_jobs: "Probe" },
        batchOperations: [
          { operation: "probe", description: "Probe.", triggers: ["operator"], maxRunSeconds: 60 },
        ],
      },
      source: `export default {slug:"${slug}",version:"1.0.0",tier:2,operations:{
        probe: async () => { await fetch("https://example.com/"); return typeof Deno.env; }
      }};`,
    });
    expect(r.ok).toBe(false);
    const message = JSON.stringify(r.ok ? null : r.error);
    expect(message).toContain("fetch() is not allowed");
    expect(message).toContain("Deno.* is not accessible");
  });

  it("an installed plugin's batch runs in the sandbox: no environment, no other plugin's data, no storage it was not granted — and its collection write works", async () => {
    const slug = installed[0]?.slug as string;
    const { run } = await op<{ run: BatchRun }>(
      "plugin_batches.start",
      { pluginSlug: slug, operation: "probe" },
      owner,
    );
    const done = await settled(run.id, 60_000);
    expect(done.error).toBeNull();
    expect(done.result).toEqual({
      // Deno has a node-style `process`; reading its environment is denied.
      env: "denied",
      other: "refused",
      adminQuery: "undefined",
      files: "undefined",
      trigger: "operator",
    });
    const changes = await adapter.withAdminTransaction(
      SYSTEM,
      async (tx) =>
        (await tx.execute(sql`
        SELECT count(*)::int AS n FROM collection_changes WHERE plugin_id = ${installed[0]?.pluginId}::uuid
      `)) as unknown as { n: number }[],
    );
    expect(changes[0]?.n).toBe(1);
  });

  it("a plugin reads its own batch runs, never another plugin's input or result", async () => {
    const own = installed[0]?.pluginId as string;
    const ids = async (ctx: ExecutionContext) =>
      adapter.withAdminTransaction(
        ctx,
        async (tx) =>
          (await tx.execute(
            sql`SELECT DISTINCT plugin_id::text AS id FROM plugin_batch_runs`,
          )) as unknown as {
            id: string;
          }[],
      );
    // The people and the system see every plugin's runs ...
    const all = (await ids(owner)).map((r) => r.id);
    expect(all).toContain(own);
    expect(all.length).toBeGreaterThan(1);
    // ... a plugin only its own, whatever it asks for.
    const asPlugin = { ...SYSTEM, actorKind: "plugin" as const, pluginId: own };
    expect((await ids(asPlugin)).map((r) => r.id)).toEqual([own]);
    expect(await ids({ ...asPlugin, pluginId: crypto.randomUUID() })).toEqual([]);
  });
});
