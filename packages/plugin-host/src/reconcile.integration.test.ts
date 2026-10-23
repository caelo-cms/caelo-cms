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
import { registerAdminOps } from "@caelo-cms/admin-core";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import {
  bootstrap,
  ensureDevSignedManifests,
  isPluginDisabled,
  loadedPlugins,
  type PluginHostInfra,
  pluginsNotRunningHere,
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

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let infra: PluginHostInfra;
/** Flipped by a test to let the flaky plugin's onActivate succeed. */
let flakyHealthy = false;

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
