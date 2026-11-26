// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — a runtime-installed plugin registers through the same seam as a
 * shipped one (docs/dev/external-plugin-brokers.md §4.3), end to end on a
 * real Postgres and the real Deno sandbox: staged, approved by an Owner,
 * activated, then brought up again at boot. Its `onActivate` runs on main
 * as the plugin actor with private storage (decision Q1 A), audited and
 * snapshotted; its declared configuration is seeded; the manifest's data
 * declarations reach its definition.
 */

import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateApprovedExternalPlugin,
  bootstrap,
  loadActivatedPlugin,
  loadedPlugins,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { lockPluginRow } from "../locks.js";
import { registerAdminOps } from "../register.js";
import { pluginWorkerTasks } from "../scheduler/plugin-workers.js";
import { runSchedulerTick } from "../scheduler/tick.js";

let adapter: DatabaseAdapter;
let pluginsRoot: string;
const registry = new OperationRegistry();
const system = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "external-seam-test",
};
const SLUG = "seam-notes";
/** Every plugin this file installs: their schemas outlive the per-file reset. */
const SCHEMAS = ["seam-notes", "seam-liar", "seam-worker", "seam-glossary"].map(
  (slug) => `plugin_${slug.replaceAll("-", "_")}`,
);
const dropSchemas = () =>
  adapter.withAdminTransaction(system, async (tx) => {
    for (const schema of SCHEMAS)
      await tx.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
  });

const manifest = {
  slug: SLUG,
  version: "1.0.0",
  tier: 2,
  schema: {},
  adminSchema: { notes: { body: "text" } },
  operations: ["read"],
  hasOnActivate: true,
  config: {
    greeting: {
      type: "bool",
      label: "Greet",
      description: "Whether the plugin greets.",
      effect: "none",
      default: true,
    },
  },
  requestedCapabilities: ["cms_admin_schema"],
  capabilityReasons: { cms_admin_schema: "Keep the plugin's notes private" },
};
const source = `export default {slug:"${SLUG}",version:"1.0.0",tier:2,
  onActivate: async (ctx) => {
    const seeded = await ctx.adminQuery.list("notes", { limit: 1 });
    if (seeded.length === 0) await ctx.adminQuery.insert("notes", { body: "seeded by onActivate" });
  },
  operations:{
    read: async (ctx) => ({ notes: await ctx.adminQuery.list("notes"), config: await ctx.config.get() }),
  }};`;

beforeAll(async () => {
  if (!process.env.ADMIN_DATABASE_URL || !process.env.PUBLIC_ADMIN_DATABASE_URL)
    throw new Error("DB URLs required");
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
    publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
  });
  registerAdminOps(registry);
  await dropSchemas();
  pluginsRoot = await mkdtemp(join(tmpdir(), "caelo-seam-test-"));
  await bootstrap({
    infra: { adapter, registry, lockPluginRow },
    pluginsRoot,
    systemActorId: system.actorId,
  });
});
afterAll(async () => {
  resetPluginHost();
  await dropSchemas();
  await rm(pluginsRoot, { recursive: true, force: true });
  await adapter.close();
});

async function call(
  name: string,
  input: unknown,
  ctx = system as { actorId: string; actorKind: "system" | "human" | "ai"; requestId: string },
) {
  const result = await execute(registry, adapter, ctx, name, input);
  if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
  return result.value;
}

async function owner() {
  const id = crypto.randomUUID();
  await adapter.withAdminTransaction(system, async (tx) => {
    await tx.execute(
      sql`INSERT INTO actors (id,kind,display_name) VALUES (${id}::uuid,'human','owner')`,
    );
    await tx.execute(
      sql`INSERT INTO users (id,email,password_hash) VALUES (${id}::uuid,${`${id}@example.test`},'test-only')`,
    );
    await tx.execute(
      sql`INSERT INTO user_roles (user_id,role_id) SELECT ${id}::uuid,id FROM roles WHERE name='owner'`,
    );
  });
  return { ...system, actorId: id, actorKind: "human" as const };
}

/** Stage, approve as an Owner and activate one external artifact. */
export async function installExternal(
  m: Record<string, unknown> & { requestedCapabilities: string[] },
  src: string,
): Promise<{ pluginId: string }> {
  const staged = (await call("plugins.stage_installation", { manifest: m, source: src })) as {
    installationId: string;
    pluginId: string;
    artifactDigest: string;
  };
  const review = (await call("plugins.list_installations", {})) as {
    installations: { id: string; currentStateDigest: string }[];
  };
  const item = review.installations.find((row) => row.id === staged.installationId);
  if (!item) throw new Error("review missing");
  await call(
    "plugins.approve_installation",
    {
      installationId: staged.installationId,
      artifactDigest: staged.artifactDigest,
      expectedStateDigest: item.currentStateDigest,
      capabilities: m.requestedCapabilities,
    },
    await owner(),
  );
  const loaded = await activateApprovedExternalPlugin(staged.installationId);
  if (!loaded.loaded) throw new Error(`activation failed: ${loaded.reason}`);
  return { pluginId: staged.pluginId };
}

it("an installed plugin's onActivate seeds private storage on main as the plugin actor, snapshotted, once per key (Q1 A)", async () => {
  const { pluginId } = await installExternal(manifest, source);
  const lp = loadedPlugins.bySlug(SLUG);
  expect(lp?.definition.onActivate).toBeDefined();
  expect(lp?.definition.config).toMatchObject(manifest.config);

  const readNotes = async () => {
    const read = await runPluginOperation({
      pluginSlug: SLUG,
      operationName: "read",
      args: {},
      invocation: { origin: "owner-panel", actorId: (await owner()).actorId },
    });
    if (!read.ok) throw new Error(JSON.stringify(read.error));
    return read.value as { notes: { id: string; body: string }[]; config: Record<string, unknown> };
  };
  const value = await readNotes();
  expect(value.notes.map((n) => n.body)).toEqual(["seeded by onActivate"]);
  // §10 gap — the declared configuration is seeded for an installed plugin.
  expect(value.config).toEqual({ greeting: true });

  // Written on main (a main-line snapshot) as the plugin's own actor.
  const snapshots = (await adapter.withAdminTransaction(system, (tx) =>
    tx.execute(sql`
      SELECT s.actor_id::text AS actor_id, s.chat_branch_id
      FROM plugin_row_snapshots r JOIN site_snapshots s ON s.id = r.site_snapshot_id
      WHERE r.plugin_id = ${pluginId}::uuid AND r.row_id = ${value.notes[0]?.id}::uuid
    `),
  )) as unknown as { actor_id: string; chat_branch_id: string | null }[];
  expect(snapshots.length).toBeGreaterThan(0);
  expect(snapshots[0]?.chat_branch_id).toBeNull();
  expect(snapshots[0]?.actor_id).toBe(lp?.pluginActorId);

  // A boot brings it up again through the same seam; onActivate is idempotent.
  expect(await loadActivatedPlugin(SLUG)).toEqual({ loaded: true });
  expect((await readNotes()).notes).toHaveLength(1);
});

it("refuses an artifact whose hasOnActivate does not match its definition", async () => {
  const slug = "seam-liar";
  const staged = (await call("plugins.stage_installation", {
    manifest: { ...manifest, slug, config: undefined, hasOnActivate: false },
    source: source.replaceAll(SLUG, slug),
  })) as { installationId: string; artifactDigest: string };
  const review = (await call("plugins.list_installations", {})) as {
    installations: { id: string; currentStateDigest: string }[];
  };
  const item = review.installations.find((row) => row.id === staged.installationId);
  await call(
    "plugins.approve_installation",
    {
      installationId: staged.installationId,
      artifactDigest: staged.artifactDigest,
      expectedStateDigest: item?.currentStateDigest,
      capabilities: manifest.requestedCapabilities,
    },
    await owner(),
  );
  const loaded = await activateApprovedExternalPlugin(staged.installationId);
  expect(loaded.loaded).toBe(false);
  expect(loaded.reason).toContain("SandboxOnActivateMismatch");
});

it("an installed plugin's worker runs on the scheduler tick, sandboxed, with private storage on main (background_workers)", async () => {
  const slug = "seam-worker";
  const workerManifest = {
    slug,
    version: "1.0.0",
    tier: 2,
    schema: { tallies: { label: "text" } },
    tableKinds: { tallies: "published" },
    adminSchema: { runs: { note: "text" } },
    operations: ["tick", "read"],
    workers: [{ name: "count_runs", cron: "* * * * *", operationName: "tick" }],
    requestedCapabilities: ["cms_admin_schema", "background_workers"],
    capabilityReasons: {
      cms_admin_schema: "Remember each run",
      background_workers: "Count runs every minute",
    },
  };
  const workerSource = `export default {slug:"${slug}",version:"1.0.0",tier:2,operations:{
    tick: async (ctx, args) => {
      await ctx.adminQuery.insert("runs", { note: args.workerName + ":" + ctx.invocation.origin });
      await ctx.query.insert("tallies", { label: "ran" });
      return null;
    },
    read: async (ctx) => ctx.adminQuery.list("runs"),
  }};`;
  const staged = (await call("plugins.stage_installation", {
    manifest: workerManifest,
    source: workerSource,
  })) as { installationId: string; pluginId: string; artifactDigest: string };
  const review = (await call("plugins.list_installations", {})) as {
    installations: { id: string; currentStateDigest: string }[];
  };
  await call(
    "plugins.approve_installation",
    {
      installationId: staged.installationId,
      artifactDigest: staged.artifactDigest,
      expectedStateDigest: review.installations.find((r) => r.id === staged.installationId)
        ?.currentStateDigest,
      capabilities: workerManifest.requestedCapabilities,
    },
    await owner(),
  );
  expect(await activateApprovedExternalPlugin(staged.installationId)).toEqual({ loaded: true });
  const lp = loadedPlugins.bySlug(slug);
  expect(lp?.definition.workers?.map((w) => w.name)).toEqual(["count_runs"]);

  const tasks = pluginWorkerTasks().filter((t) => t.key.startsWith(`plugin:${slug}/`));
  expect(tasks.map((t) => t.key)).toEqual([`plugin:${slug}/count_runs`]);
  const report = await runSchedulerTick({
    adapter,
    registry,
    tasks,
    holder: "external-worker-test",
  });
  expect(report.ran).toMatchObject([{ key: `plugin:${slug}/count_runs`, outcome: "ok" }]);

  const read = await runPluginOperation({
    pluginSlug: slug,
    operationName: "read",
    args: {},
    invocation: { origin: "owner-panel", actorId: (await owner()).actorId },
  });
  if (!read.ok) throw new Error(JSON.stringify(read.error));
  const runs = read.value as { id: string; note: string }[];
  expect(runs.map((r) => r.note)).toEqual(["count_runs:worker"]);
  // Main line, as the plugin actor, snapshotted (Q1 A).
  const snapshots = (await adapter.withAdminTransaction(system, (tx) =>
    tx.execute(sql`
      SELECT s.actor_id::text AS actor_id, s.chat_branch_id
      FROM plugin_row_snapshots r JOIN site_snapshots s ON s.id = r.site_snapshot_id
      WHERE r.plugin_id = ${staged.pluginId}::uuid AND r.row_id = ${runs[0]?.id}::uuid
    `),
  )) as unknown as { actor_id: string; chat_branch_id: string | null }[];
  expect(snapshots[0]).toEqual({ actor_id: lp?.pluginActorId ?? "", chat_branch_id: null });

  // A revoked grant stops the next run before its first SDK call.
  await call(
    "plugins.revoke_capability",
    { installationId: staged.installationId, capability: "background_workers" },
    await owner(),
  );
  const after = await tasks[0]?.run().then(
    () => "ran",
    (e: Error) => e.message,
  );
  expect(after).toMatch(/ExternalPlugin(ApprovalChanged|GrantChanged)|disabled/);
});

it("an installed plugin's list types are stored as types it owns while it runs (list_types)", async () => {
  const slug = "seam-glossary";
  const listType = {
    slug: `${slug}-terms`,
    name: "Glossary terms",
    purpose: "Words the plugin explains on the site.",
    role: "content" as const,
    root: { allow: ["term"] },
    nodes: {
      term: {
        label: "Term",
        fields: [{ name: "word", label: "Word", type: "text" as const, required: true }],
      },
    },
  };
  const { pluginId } = await installExternal(
    {
      slug,
      version: "1.0.0",
      tier: 2,
      schema: {},
      operations: ["noop"],
      listTypes: [listType],
      requestedCapabilities: ["list_types"],
      capabilityReasons: { list_types: "Let editors keep the glossary as a list" },
    },
    `export default {slug:"${slug}",version:"1.0.0",tier:2,operations:{noop:async()=>null}};`,
  );
  const rows = (await adapter.withAdminTransaction(system, (tx) =>
    tx.execute(sql`
      SELECT plugin_id::text AS plugin_id, definition->>'name' AS name
      FROM list_types WHERE slug = ${listType.slug} AND chat_branch_id IS NULL AND deleted_at IS NULL
    `),
  )) as unknown as { plugin_id: string; name: string }[];
  expect([...rows]).toEqual([{ plugin_id: pluginId, name: "Glossary terms" }]);
  // A boot re-syncs from the verified manifest and writes nothing new.
  expect(await loadActivatedPlugin(slug)).toEqual({ loaded: true });
});

it("refuses an installed plugin's list type without its prefix at staging", async () => {
  const r = await execute(
    registry,
    adapter,
    { ...system, actorKind: "ai" },
    "plugins.stage_installation",
    {
      manifest: {
        slug: "seam-noprefix",
        version: "1.0.0",
        tier: 2,
        schema: {},
        operations: ["noop"],
        listTypes: [
          {
            slug: "glossary",
            name: "Glossary",
            purpose: "Words.",
            role: "content",
            root: { allow: ["term"] },
            nodes: {
              term: { label: "Term", fields: [{ name: "word", label: "Word", type: "text" }] },
            },
          },
        ],
        requestedCapabilities: ["list_types"],
        capabilityReasons: { list_types: "Glossary" },
      },
      source: `export default {slug:"seam-noprefix",version:"1.0.0",tier:2,operations:{noop:async()=>null}};`,
    },
  );
  expect(r.ok).toBe(false);
  if (!r.ok) expect(JSON.stringify(r.error)).toContain('must start with \\"seam-noprefix-\\"');
});
