// SPDX-License-Identifier: MPL-2.0

/**
 * Collecting client assets from real, loaded plugins.
 *
 * The channel exists so a plugin can guarantee browser behaviour the
 * site's markup cannot be trusted to provide (#449). That guarantee is
 * only worth something if the failure modes are loud: a plugin whose
 * runtime silently stops shipping is the exact defect this pass must
 * never produce. So the invalid cases below assert a THROW, not a
 * degraded build.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import {
  bootstrap,
  collectBuildAssets,
  type PluginHostInfra,
  resetPluginHost,
  setPluginDisabled,
} from "./index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SLUG = "test-assets-runtime";
const PAGE_IDS = ["11111111-1111-1111-1111-111111111111"];

let adapter: DatabaseAdapter;
let infra: PluginHostInfra;

async function wipe(): Promise<void> {
  resetPluginHost();
  const sql = new SQL(ADMIN_URL);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM audit_events WHERE actor_id IN (
        SELECT id FROM actors WHERE plugin_id IN (
          SELECT id FROM plugins WHERE slug LIKE 'test-assets-%'
        )
      )`;
      await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 'test-assets-%')`;
      await tx`DELETE FROM plugins WHERE slug LIKE 'test-assets-%'`;
    });
  } finally {
    await sql.end();
  }
}

/** @param files what the fixture's buildAssets returns. */
function fixture(files: Record<string, string> | (() => never)) {
  return definePlugin({
    slug: SLUG,
    version: "0.1.0",
    tier: 1,
    schema: {},
    operations: { noop: async () => ({}) },
    buildAssets: (_ctx, args) => {
      if (typeof files === "function") return files();
      // Prove the page list actually reaches the plugin — baking
      // per-page data is the whole reason it is passed.
      return Object.fromEntries(
        Object.entries(files).map(([k, v]) => [
          k,
          v.replace("__PAGES__", String(args.pageIds.length)),
        ]),
      );
    },
  });
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  const registry = new OperationRegistry();
  registerAdminOps(registry);
  infra = { adapter, registry };
});

afterEach(async () => {
  await wipe();
});

afterAll(async () => {
  await adapter.close();
});

async function load(definition: ReturnType<typeof definePlugin>): Promise<void> {
  const report = await bootstrap({
    infra,
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition }],
  });
  if (report.failed.length > 0) {
    throw new Error(`fixture failed to load: ${report.failed[0]?.reason}`);
  }
}

describe("collectBuildAssets", () => {
  it("emits the plugin's files with the content hash in the name", async () => {
    await load(fixture({ "runtime.js": "/* pages: __PAGES__ */", "runtime.css": ".c{}" }));
    const assets = await collectBuildAssets(PAGE_IDS);

    expect(assets).toHaveLength(2);
    const js = assets.find((a) => a.kind === "js");
    expect(js?.content).toBe("/* pages: 1 */");
    expect(js?.relPath).toMatch(new RegExp(`^_caelo/plugin/${SLUG}/runtime\\.[0-9a-f]{12}\\.js$`));
    expect(js?.publicPath).toBe(`/${js?.relPath}`);
  });

  it("gives identical content the same name and changed content a new one", async () => {
    // The name is what a CDN caches against; if it did not move when the
    // behaviour moved, a deploy would leave stale plugin code live.
    await load(fixture({ "runtime.js": "v1" }));
    const first = (await collectBuildAssets(PAGE_IDS))[0]?.relPath;
    const again = (await collectBuildAssets(PAGE_IDS))[0]?.relPath;
    expect(again).toBe(first);

    await wipe();
    await load(fixture({ "runtime.js": "v2" }));
    expect((await collectBuildAssets(PAGE_IDS))[0]?.relPath).not.toBe(first);
  });

  it("emits nothing for a plugin that is switched off", async () => {
    await load(fixture({ "runtime.js": "x" }));
    setPluginDisabled(SLUG, true);
    expect(await collectBuildAssets(PAGE_IDS)).toEqual([]);
    setPluginDisabled(SLUG, false);
    expect(await collectBuildAssets(PAGE_IDS)).toHaveLength(1);
  });

  it("costs nothing when no plugin contributes", async () => {
    await load(
      definePlugin({
        slug: SLUG,
        version: "0.1.0",
        tier: 1,
        schema: {},
        operations: { noop: async () => ({}) },
      }),
    );
    expect(await collectBuildAssets(PAGE_IDS)).toEqual([]);
  });

  it("rejects a file name that is not a plain .js or .css", async () => {
    await load(fixture({ "../escape.js": "x" }));
    expect(collectBuildAssets(PAGE_IDS)).rejects.toThrow(/invalid asset name/);
  });

  it("rejects a payload over the per-plugin budget", async () => {
    await load(fixture({ "runtime.js": "x".repeat(600 * 1024) }));
    expect(collectBuildAssets(PAGE_IDS)).rejects.toThrow(/budget/);
  });

  it("fails the build when the plugin's own asset build throws", async () => {
    await load(
      fixture(() => {
        throw new Error("config table missing");
      }),
    );
    expect(collectBuildAssets(PAGE_IDS)).rejects.toThrow(/config table missing/);
  });
});
