// SPDX-License-Identifier: MPL-2.0

/**
 * Visitor-facing dispatch is default deny.
 *
 * Until this landed, every operation a plugin declared was reachable by
 * anyone through `POST /api/plugin/<slug>/<op>` — with the plugin's full
 * granted capabilities. That put `comments/moderate`,
 * `forms/list_submissions`, `newsletter/send_campaign`,
 * `auth/apply_auth_config` and `international-site/set_locales` on the
 * open internet behind nothing but a rate limit.
 *
 * The check lives in `runPluginOperation` rather than at the gateway
 * route, so these tests exercise the invariant itself: a visitor
 * context cannot reach an undeclared operation regardless of which
 * entry point supplies it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { bootstrap, type PluginHostInfra, resetPluginHost, runPluginOperation } from "./index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SLUG = "test-public-ops";

const VISITOR = { visitorId: "v-1", sessionToken: null };

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
          SELECT id FROM plugins WHERE slug LIKE 'test-public-ops%'
        )
      )`;
      await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 'test-public-ops%')`;
      await tx`DELETE FROM plugins WHERE slug LIKE 'test-public-ops%'`;
    });
  } finally {
    await sql.end();
  }
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

async function load(publicOperations?: string[]): Promise<void> {
  const def = definePlugin({
    slug: SLUG,
    version: "0.1.0",
    tier: 1,
    schema: {},
    ...(publicOperations ? { publicOperations } : {}),
    operations: {
      submit: async () => ({ accepted: true }),
      moderate: async () => ({ moderated: true }),
    },
  });
  const report = await bootstrap({
    infra,
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: def }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
}

describe("visitor-facing dispatch", () => {
  it("allows a declared public operation", async () => {
    await load(["submit"]);
    const r = await runPluginOperation({
      pluginSlug: SLUG,
      operationName: "submit",
      args: {},
      visitorContext: VISITOR,
    });
    expect(r.ok).toBe(true);
  });

  it("refuses an operation that is not declared public", async () => {
    await load(["submit"]);
    const r = await runPluginOperation({
      pluginSlug: SLUG,
      operationName: "moderate",
      args: {},
      visitorContext: VISITOR,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("OperationNotPublic");
  });

  it("refuses everything when the plugin declares no public surface", async () => {
    // The default matters more than the allowlist: a plugin author who
    // never thinks about the gateway exposes nothing.
    await load();
    for (const operationName of ["submit", "moderate"]) {
      const r = await runPluginOperation({
        pluginSlug: SLUG,
        operationName,
        args: {},
        visitorContext: VISITOR,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("OperationNotPublic");
    }
  });

  it("leaves internal dispatch untouched", async () => {
    // Workers, the chat-runner and the render passes all dispatch
    // without a visitor; gating them would break every plugin.
    await load(["submit"]);
    const r = await runPluginOperation({
      pluginSlug: SLUG,
      operationName: "moderate",
      args: {},
    });
    expect(r.ok).toBe(true);
  });

  it("refuses to load a plugin whose public list names a missing operation", async () => {
    // A typo here silently 404s the visitor surface, or advertises one
    // that does not exist. Both are caught at load.
    const def = definePlugin({
      slug: `${SLUG}-typo`,
      version: "0.1.0",
      tier: 1,
      schema: {},
      publicOperations: ["submitt"],
      operations: { submit: async () => ({}) },
    });
    const report = await bootstrap({
      infra,
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: def }],
    });
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.reason).toContain("publicOperations");
  });
});
