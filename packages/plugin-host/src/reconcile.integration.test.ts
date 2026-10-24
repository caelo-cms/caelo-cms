// SPDX-License-Identifier: MPL-2.0

/**
 * #1008 — this instance follows plugin decisions made anywhere.
 *
 * The 2026-10-22 incident: a plugin's row changed while another instance
 * kept running it from memory, and the editor preview broke there. Each
 * test changes the plugin rows directly in SQL — exactly what another
 * instance's op (or a manual repair) does from this process's point of
 * view — and checks that `syncPluginHost` brings the host in line, that it
 * only reconciles when the rows changed, that a failing plugin is reported
 * as not running here and comes up after `plugins.reload`, and that an
 * unchanged boot does not write the plugin row (no instance ping-pong).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAdminOps, startPublicProjectionPublisher } from "@caelo-cms/admin-core";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import {
  bootstrap,
  ensureDevSignedManifests,
  isPluginDisabled,
  loadActivatedPlugin,
  loadedPlugins,
  type PluginHostInfra,
  pluginsNotRunningHere,
  pluginWorkerScheduler,
  resetPluginHost,
  resetPluginHostSync,
  syncPluginHost,
} from "./index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYSTEM: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t1008-reconcile",
};
const PREFIX = "t1008r-";
const STEADY = `${PREFIX}steady`;
const FLAKY = `${PREFIX}flaky`;
const DISK = `${PREFIX}disk`;
const WORKERED = `${PREFIX}workered`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let infra: PluginHostInfra;
/** Flipped by a test to let the flaky plugin's onActivate succeed. */
let flakyHealthy = false;
/** How often the workered plugin's onActivate ran (one per load). */
let workeredActivations = 0;

async function sqlSystem<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

/** The row version of a plugin row — changes on every UPDATE. */
async function rowVersion(slug: string): Promise<string | undefined> {
  const rows = await sqlSystem(
    async (tx) =>
      (await tx`SELECT xmin::text AS v FROM plugins WHERE slug = ${slug}`) as { v: string }[],
  );
  return rows[0]?.v;
}

/** This instance's runtime-health states for a plugin. */
async function runtimeStates(slug: string): Promise<string[]> {
  const rows = await sqlSystem(
    async (tx) =>
      (await tx`SELECT state FROM plugin_runtime WHERE plugin_slug = ${slug}`) as {
        state: string;
      }[],
  );
  return rows.map((r) => r.state);
}

async function wipe(): Promise<void> {
  resetPluginHost();
  resetPluginHostSync();
  await sqlSystem(async (tx) => {
    await tx`DELETE FROM plugin_runtime WHERE plugin_slug LIKE ${`${PREFIX}%`}`;
    await tx`DELETE FROM plugin_errors WHERE plugin_slug LIKE ${`${PREFIX}%`}`;
    await tx`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE ${`${PREFIX}%`}))`;
    await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE ${`${PREFIX}%`})`;
    await tx`DELETE FROM plugins WHERE slug LIKE ${`${PREFIX}%`}`;
  });
}

const steady = definePlugin({
  slug: STEADY,
  version: "0.1.0",
  tier: 1,
  schema: {},
  operations: { noop: async () => ({}) },
});

const flaky = definePlugin({
  slug: FLAKY,
  version: "0.1.0",
  tier: 1,
  schema: {},
  operations: { noop: async () => ({}) },
  onActivate: async () => {
    if (!flakyHealthy) throw new Error("upstream not configured yet");
  },
});

const workered = definePlugin({
  slug: WORKERED,
  version: "0.1.0",
  tier: 1,
  schema: {},
  requestedCapabilities: ["background_workers"],
  operations: { noop: async () => ({}) },
  workers: [{ name: "tick", cron: "0 0 * * *", operationName: "noop" }], // daily; never fires here
  onActivate: async () => {
    workeredActivations += 1;
    // Slow enough that two loads started together overlap.
    await Bun.sleep(150);
    if (!flakyHealthy) throw new Error("upstream not configured yet");
  },
});

function boot(plugins = [steady, flaky]) {
  return bootstrap({
    infra,
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: plugins.map((definition) => ({ definition })),
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  infra = { adapter, registry };
});

beforeEach(async () => {
  flakyHealthy = false;
  workeredActivations = 0;
  await wipe();
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("#1008 — syncPluginHost follows the plugin rows", () => {
  it("stops, resumes and unloads a plugin when another instance changed its row", async () => {
    await boot([steady]);
    await syncPluginHost(true);
    expect(loadedPlugins.bySlug(STEADY)).toBeDefined();
    expect(isPluginDisabled(STEADY)).toBe(false);

    expect(await runtimeStates(STEADY)).toEqual(["loaded"]);

    await sqlSystem(
      async (tx) => tx`UPDATE plugins SET status = 'disabled' WHERE slug = ${STEADY}`,
    );
    await syncPluginHost(true);
    expect(isPluginDisabled(STEADY)).toBe(true);
    expect(await runtimeStates(STEADY)).toEqual([]);

    await sqlSystem(async (tx) => tx`UPDATE plugins SET status = 'active' WHERE slug = ${STEADY}`);
    await syncPluginHost(true);
    expect(isPluginDisabled(STEADY)).toBe(false);
    // Resumed here, so this server counts in the plugin's health again.
    expect(await runtimeStates(STEADY)).toEqual(["loaded"]);

    await sqlSystem(async (tx) => {
      await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${STEADY})`;
      await tx`DELETE FROM plugins WHERE slug = ${STEADY}`;
    });
    await syncPluginHost(true);
    expect(loadedPlugins.bySlug(STEADY)).toBeUndefined();
  });

  it("reconciles only when the plugin rows changed", async () => {
    await boot([steady]);
    await syncPluginHost(true);
    // Unload it locally behind the database's back: unchanged rows must
    // not touch the host (no per-request reconcile work).
    const lp = loadedPlugins.bySlug(STEADY);
    expect(lp).toBeDefined();
    loadedPlugins.unload(STEADY);
    await Bun.sleep(2_100); // past the throttle
    await syncPluginHost();
    expect(loadedPlugins.bySlug(STEADY)).toBeUndefined();
    // A row change does trigger it, and the active plugin comes back.
    await sqlSystem(async (tx) => tx`UPDATE plugins SET updated_at = now() WHERE slug = ${STEADY}`);
    await Bun.sleep(2_100);
    await syncPluginHost();
    expect(loadedPlugins.bySlug(STEADY)).toBeDefined();
  });

  it("reports a failing active plugin as not running here, and plugins.reload brings it up", async () => {
    const report = await boot();
    expect(report.failed.map((f) => f.slug)).toEqual([FLAKY]);
    await syncPluginHost(true);
    expect(loadedPlugins.bySlug(STEADY)).toBeDefined();
    expect(loadedPlugins.bySlug(FLAKY)).toBeUndefined();
    expect(pluginsNotRunningHere()).toEqual([
      { slug: FLAKY, reason: expect.stringContaining("upstream not configured yet") },
    ]);

    flakyHealthy = true;
    const r = await execute(registry, adapter, SYSTEM, "plugins.reload", { slug: FLAKY });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    // The op reconciles this instance after its commit.
    expect(loadedPlugins.bySlug(FLAKY)).toBeDefined();
    expect(pluginsNotRunningHere()).toEqual([]);
    const got = await execute(registry, adapter, SYSTEM, "plugins.get", { slug: FLAKY });
    if (!got.ok) throw new Error(JSON.stringify(got.error));
    expect((got.value as { plugin: { health: { state: string } } }).plugin.health.state).toBe(
      "running",
    );
  });

  it("a write not yet committed at the first read is still picked up after it commits", async () => {
    await boot([steady]);
    await syncPluginHost(true);
    const writer = new SQL(ADMIN_URL as string);
    try {
      await writer.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`UPDATE plugins SET status = 'disabled' WHERE slug = ${STEADY}`;
        // Read while the change is uncommitted: nothing to do yet.
        await syncPluginHost(true);
        expect(isPluginDisabled(STEADY)).toBe(false);
      });
    } finally {
      await writer.end();
    }
    // Committed now: an ordinary (unforced) check must see it.
    await Bun.sleep(2_100);
    await syncPluginHost();
    expect(isPluginDisabled(STEADY)).toBe(true);
  });

  it("forgets a failing plugin once it is uninstalled", async () => {
    await boot();
    await syncPluginHost(true);
    expect(pluginsNotRunningHere().map((p) => p.slug)).toEqual([FLAKY]);
    await sqlSystem(async (tx) => {
      await tx`DELETE FROM plugin_runtime WHERE plugin_slug = ${FLAKY}`;
      await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${FLAKY})`;
      await tx`DELETE FROM plugins WHERE slug = ${FLAKY}`;
    });
    await syncPluginHost(true);
    expect(pluginsNotRunningHere()).toEqual([]);
  });

  it("plugins.reload refuses a plugin that is not active, naming the next step", async () => {
    await boot([steady]);
    await sqlSystem(
      async (tx) => tx`UPDATE plugins SET status = 'disabled' WHERE slug = ${STEADY}`,
    );
    const r = await execute(registry, adapter, SYSTEM, "plugins.reload", { slug: STEADY });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).toContain("Owner's decision");
    const missing = await execute(registry, adapter, SYSTEM, "plugins.reload", {
      slug: `${PREFIX}nope`,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(JSON.stringify(missing.error)).toContain("list_plugins");
  });

  it("a boot with an unchanged release does not write the plugin row", async () => {
    // A disk plugin, signed once with a test key: what production boots.
    // (In-memory test plugins are re-signed with a fresh key per boot, so
    // their row really changes every time.)
    const root = mkdtempSync(join(tmpdir(), "t1008r-"));
    try {
      mkdirSync(join(root, DISK, "dist"), { recursive: true });
      writeFileSync(
        join(root, DISK, "dist", "index.js"),
        `export default { slug: "${DISK}", version: "0.1.0", tier: 1, schema: {}, operations: { noop: async () => ({}) } };\n`,
      );
      const signed = await ensureDevSignedManifests({
        pluginsRoot: root,
        keyPath: join(root, ".key"),
      });
      expect(signed.reports.map((r) => r.status)).toEqual(["signed"]);
      const opts = {
        infra,
        pluginsRoot: root,
        systemActorId: SYSTEM_ACTOR_ID,
        publicKeyHex: signed.publicKeyHex,
      };
      await bootstrap(opts);
      await sqlSystem(async (tx) => tx`UPDATE plugins SET status = 'active' WHERE slug = ${DISK}`);
      resetPluginHost();
      const first = await bootstrap(opts);
      expect(first.loaded.map((l) => l.slug)).toContain(DISK);
      const before = await rowVersion(DISK);
      resetPluginHost();
      const second = await bootstrap(opts);
      expect(second.loaded.map((l) => l.slug)).toContain(DISK);
      expect(await rowVersion(DISK)).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#1052 — an active plugin this release does not ship", () => {
  const GONE = `${PREFIX}gone`;

  async function seedOrphanRow(): Promise<void> {
    // The shape pre-0.10.24 boots left behind: an `active` tier-1 row for a
    // built-in plugin whose directory a later release deleted.
    await sqlSystem(
      async (tx) => tx`
        INSERT INTO plugins (slug, version, tier, status, manifest_json, source_path,
                             manifest_signature, submitted_by)
        VALUES (${GONE}, '0.1.0', 1, 'active', '{}'::jsonb, ${`packages/plugins/${GONE}`},
                'unknown', ${SYSTEM_ACTOR_ID}::uuid)`,
    );
  }

  async function bugReportsFor(slug: string): Promise<number> {
    const rows = await sqlSystem(
      async (tx) =>
        (await tx`SELECT count(*)::int AS n FROM ai_bug_reports WHERE title LIKE ${`%${slug}%`}`) as {
          n: number;
        }[],
    );
    return rows[0]?.n ?? 0;
  }

  it("is recorded as not part of this release, never filed as a core bug, and stays active", async () => {
    const root = mkdtempSync(join(tmpdir(), "t1052-"));
    try {
      await sqlSystem(async (tx) => tx`DELETE FROM ai_bug_reports WHERE title LIKE ${`%${GONE}%`}`);
      await seedOrphanRow();
      // Two instances in a row (the second is a fresh host on the same DB).
      for (let instance = 0; instance < 2; instance++) {
        resetPluginHost();
        resetPluginHostSync();
        await bootstrap({ infra, pluginsRoot: root, systemActorId: SYSTEM_ACTOR_ID });
        await syncPluginHost(true);
        const notRunning = pluginsNotRunningHere().find((p) => p.slug === GONE);
        expect(notRunning?.reason).toContain("is not part of this release");
        expect(notRunning?.reason).toContain("uninstall it at /settings/plugins");
      }

      const errors = await sqlSystem(
        async (tx) =>
          (await tx`SELECT error_class, occurrences, bug_report_id FROM plugin_errors
                    WHERE plugin_slug = ${GONE}`) as {
            error_class: string;
            occurrences: number;
            bug_report_id: string | null;
          }[],
      );
      // One folded record, the plugin's problem, not linked to a bug report.
      expect(errors).toEqual([{ error_class: "plugin", occurrences: 2, bug_report_id: null }]);
      expect(await bugReportsFor(GONE)).toBe(0);
      // Never switched off by the host: the status is the Owner's.
      const status = await sqlSystem(
        async (tx) =>
          (await tx`SELECT status FROM plugins WHERE slug = ${GONE}`) as { status: string }[],
      );
      expect(status[0]?.status).toBe("active");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#1008 — loads of one plugin never overlap", () => {
  it("an activation and a reconcile at the same time load it once, with one set of workers", async () => {
    // Active but not running here: its first load failed.
    const report = await boot([workered]);
    expect(report.failed.map((f) => f.slug)).toEqual([WORKERED]);
    expect(loadedPlugins.bySlug(WORKERED)).toBeUndefined();

    flakyHealthy = true;
    workeredActivations = 0;
    // The Owner's activation path and the request-time reconcile race.
    const [activated] = await Promise.all([loadActivatedPlugin(WORKERED), syncPluginHost(true)]);
    expect(activated.loaded).toBe(true);
    expect(loadedPlugins.bySlug(WORKERED)).toBeDefined();
    expect(workeredActivations).toBe(1);
    expect(pluginWorkerScheduler.list().filter((w) => w.pluginSlug === WORKERED)).toHaveLength(1);
  });

  it("a plugin loaded again replaces its workers instead of adding to them", async () => {
    flakyHealthy = true;
    await boot([workered]);
    const before = pluginWorkerScheduler.list().filter((w) => w.pluginSlug === WORKERED);
    expect(before).toHaveLength(1);
    // A second, sequential load (a reload or an update) registers it again.
    expect((await loadActivatedPlugin(WORKERED)).loaded).toBe(true);
    const after = pluginWorkerScheduler.list().filter((w) => w.pluginSlug === WORKERED);
    expect(after).toHaveLength(1);
    // The first load's job was stopped, not orphaned.
    expect(before[0]?.job.isStopped()).toBe(true);
  });
});

describe("#1077 — a load publishes the plugin's visitor projection from this instance", () => {
  const PROJECTED = `${PREFIX}projected`;
  const SCHEMA = "plugin_t1008r_projected";
  const projected = definePlugin({
    slug: PROJECTED,
    version: "0.1.0",
    tier: 1,
    schema: {},
    adminSchema: { settings: { label: "string" } },
    visitorProjection: { settings: ["label"] },
    requestedCapabilities: ["cms_admin_schema"],
    operations: { noop: async () => ({}) },
  });

  async function publishedSections(): Promise<string[]> {
    const pub = new SQL(PUBLIC_URL as string);
    try {
      return await pub.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        const rows = (await tx`SELECT section FROM published_projection_sections`) as {
          section: string;
        }[];
        return rows.map((r) => r.section);
      });
    } finally {
      await pub.end();
    }
  }

  async function withdraw(section: string): Promise<void> {
    const pub = new SQL(PUBLIC_URL as string);
    try {
      await pub.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`DELETE FROM published_projection_sections WHERE section = ${section}`;
      });
    } finally {
      await pub.end();
    }
  }

  it("publishes it on load, and again on a reload, without waiting for the plugin's next write", async () => {
    // The admin's own publisher, as hooks.server.ts wires it; the poll is
    // parked so only the publish right after a write can run.
    const publisher = startPublicProjectionPublisher({ adapter, intervalMs: 3_600_000 });
    try {
      const report = await boot([projected]);
      expect(report.failed).toEqual([]);
      const section = `plugin:${loadedPlugins.bySlug(PROJECTED)?.pluginId}`;
      expect(await publishedSections()).toContain(section);

      // Gone from the public side (a publisher that misread "not loaded
      // here" as "declares nothing" did this, #1077). Loading the plugin
      // again republishes it from this instance's definition.
      await withdraw(section);
      expect((await loadActivatedPlugin(PROJECTED)).loaded).toBe(true);
      expect(await publishedSections()).toContain(section);
    } finally {
      publisher.stop();
      await sqlSystem(async (tx) => {
        await tx.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
        await tx`DELETE FROM plugin_schema_migrations WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${PROJECTED})`;
      });
    }
  });
});
