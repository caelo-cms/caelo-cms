// SPDX-License-Identifier: MPL-2.0

/**
 * #1737 — a runtime-installed plugin cannot declare a static render until
 * the build can bake one (docs/dev/external-plugin-brokers.md §10): the
 * static build bakes only release-signed plugins' renders, so an installed
 * plugin's would never reach a published page.
 *
 * - Submission and staging refuse it, naming the issue and the next step.
 * - An installed plugin an older release approved with one stops at its
 *   next load, loudly: the load error is recorded for the Owner (#1008,
 *   Settings → Plugins, get_plugin), its status stays the Owner's, and
 *   nothing of it runs.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrap,
  loadActivatedPlugin,
  loadedPlugins,
  resetPluginHost,
} from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { lockPluginRow } from "../locks.js";
import { registerAdminOps } from "../register.js";
import { externalPluginFlow, FLOW_SYSTEM } from "./_external-plugin-flow.js";

let adapter: DatabaseAdapter;
let pluginsRoot: string;
const registry = new OperationRegistry();
const SLUG = "render-probe";
const flow = externalPluginFlow({
  adapter: () => adapter,
  registry,
  prefix: "t1737sr",
  schemas: [],
});

const manifest = {
  slug: SLUG,
  version: "1.0.0",
  tier: 2,
  schema: {},
  operations: ["ping"],
  hasStaticRender: false,
  requestedCapabilities: [] as string[],
};
const source = `export default {slug:"${SLUG}",version:"1.0.0",tier:2,
  operations:{ ping: async () => "pong" },
  staticRender: async () => "<p>baked</p>",
};`;

async function sqlSystem<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(process.env.ADMIN_DATABASE_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  if (!process.env.ADMIN_DATABASE_URL || !process.env.PUBLIC_ADMIN_DATABASE_URL)
    throw new Error("DB URLs required");
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
    publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
  });
  registerAdminOps(registry);
  pluginsRoot = await mkdtemp(join(tmpdir(), "caelo-static-render-test-"));
  await bootstrap({
    infra: { adapter, registry, lockPluginRow },
    pluginsRoot,
    systemActorId: FLOW_SYSTEM.actorId,
  });
  // Generous: installing runs the sandbox, and a loaded machine slows it.
}, 180_000);
afterAll(async () => {
  resetPluginHost();
  await rm(pluginsRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("#1737 — an installed plugin's static render is refused until the build bakes it", () => {
  it("staging and submission refuse it, naming the issue and what to do instead", async () => {
    const staged = await execute(registry, adapter, FLOW_SYSTEM, "plugins.stage_installation", {
      manifest: { ...manifest, hasStaticRender: true },
      source,
    });
    expect(staged.ok).toBe(false);
    expect(JSON.stringify(staged)).toContain("(#1737)");
    expect(JSON.stringify(staged)).toContain("Web Component (`component`)");
  }, 60_000);

  it("an installed plugin approved with one stops loudly at its next load", async () => {
    await flow.install(manifest, source);
    expect(loadedPlugins.bySlug(SLUG)).toBeDefined();
    // What an older release could approve: the same artifact declaring the render.
    await sqlSystem(
      (tx) =>
        tx`UPDATE plugins SET manifest_json = jsonb_set(manifest_json, '{hasStaticRender}', 'true')
            WHERE slug = ${SLUG}`,
    );

    const reloaded = await loadActivatedPlugin(SLUG);
    expect(reloaded.loaded).toBe(false);
    expect(reloaded.reason).toContain("(#1737)");
    expect(loadedPlugins.bySlug(SLUG)).toBeUndefined();

    const rows = await sqlSystem(
      (tx) =>
        tx`SELECT p.status, e.phase, e.error_class, e.message
             FROM plugins p JOIN plugin_errors e ON e.plugin_slug = p.slug
            WHERE p.slug = ${SLUG}`,
    );
    const [row] = rows as unknown as {
      status: string;
      phase: string;
      error_class: string;
      message: string;
    }[];
    // Recorded for the Owner, never switched off by the host (#1008).
    expect(row?.status).toBe("active");
    expect(row?.phase).toBe("verify");
    // The artifact's state, not a Caelo defect: no bug-intake report.
    expect(row?.error_class).toBe("plugin");
    expect(row?.message).toContain("External declaration unavailable");
    expect(row?.message).toContain("submit_plugin");
  }, 120_000);
});
