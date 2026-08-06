// SPDX-License-Identifier: MPL-2.0

/**
 * #389 — plugin-owned cms_admin schema, end to end against real
 * Postgres: provisioning at load, ctx.adminQuery scoping, per-plugin
 * RLS isolation (adversarial cross-plugin probes), ref: FK cascade
 * from a core table, and additive schema evolution on re-bootstrap.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { registerAdminOps } from "@caelo-cms/admin-core";
import { definePlugin, type PluginAdminQuery } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import {
  bootstrap,
  loadedPlugins,
  type PluginHostInfra,
  resetPluginHost,
  runPluginOperation,
} from "./index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let infra: PluginHostInfra;

type AdminCtx = { adminQuery?: PluginAdminQuery };

function makeNotesPlugin(slug: string, extraColumns: Record<string, string> = {}) {
  return definePlugin({
    slug,
    version: "0.1.0",
    tier: 1,
    schema: {},
    adminSchema: {
      notes: { body: "text", page_id: "ref:pages:cascade", ...extraColumns },
    },
    requestedCapabilities: ["cms_admin_schema"],
    operations: {
      add_note: async (ctx, args) => {
        const q = (ctx as AdminCtx).adminQuery;
        if (!q) throw new Error("ctx.adminQuery missing — capability not attached");
        const a = args as { body: string; pageId: string };
        return q.insert("notes", { body: a.body, page_id: a.pageId });
      },
      list_notes: async (ctx) => {
        const q = (ctx as AdminCtx).adminQuery;
        if (!q) throw new Error("ctx.adminQuery missing");
        return q.list("notes", {});
      },
      probe_foreign_table: async (ctx) => {
        // Adversarial: this plugin's schemaMap does not declare the
        // other plugin's table — the handle must refuse by name.
        const q = (ctx as AdminCtx).adminQuery;
        if (!q) throw new Error("ctx.adminQuery missing");
        return q.list("foreign_notes", {});
      },
    },
  });
}

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
    await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_t389_alpha" CASCADE');
    await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_t389_beta" CASCADE');
    await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't389-%')
    )`);
    await tx.unsafe(
      "DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't389-%')",
    );
    await tx.unsafe("DELETE FROM plugins WHERE slug LIKE 't389-%'");
    await tx.unsafe("DELETE FROM pages WHERE slug LIKE 't389-%'");
    await tx.unsafe("DELETE FROM templates WHERE slug LIKE 't389-%'");
    await tx.unsafe("DELETE FROM layouts WHERE slug LIKE 't389-%'");
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  infra = { adapter, registry };
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

describe("#389 — plugin-owned cms_admin schema", () => {
  it("provisions at load, ctx.adminQuery round-trips, FK cascades from pages", async () => {
    const report = await bootstrap({
      infra,
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: makeNotesPlugin("t389-alpha") }],
    });
    expect(report.failed).toEqual([]);

    // Schema + table exist in cms_admin with FORCE RLS + policy.
    const meta = await withSystemSql(async (tx) => {
      const tables = (await tx.unsafe(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'plugin_t389_alpha' AND c.relname = 'notes'`,
      )) as { relrowsecurity: boolean; relforcerowsecurity: boolean }[];
      const policies = (await tx.unsafe(
        `SELECT COUNT(*)::int AS n FROM pg_policies
         WHERE schemaname = 'plugin_t389_alpha' AND tablename = 'notes'`,
      )) as { n: number }[];
      return { table: tables[0], policyCount: policies[0]?.n ?? 0 };
    });
    expect(meta.table?.relrowsecurity).toBe(true);
    expect(meta.table?.relforcerowsecurity).toBe(true);
    expect(meta.policyCount).toBeGreaterThanOrEqual(1);

    // A real core page to FK onto.
    const pageId = await withSystemSql(async (tx) => {
      const lay = (await tx.unsafe(
        `INSERT INTO layouts (slug, display_name, html, css) VALUES ('t389-lay', 'L', '<html></html>', '') RETURNING id::text AS id`,
      )) as { id: string }[];
      const tpl = (await tx.unsafe(
        `INSERT INTO templates (slug, display_name, kind, html, css, layout_id) VALUES ('t389-tpl', 'T', 'home', '<main></main>', '', '${lay[0]?.id}') RETURNING id::text AS id`,
      )) as { id: string }[];
      const pg = (await tx.unsafe(
        `INSERT INTO pages (slug, name, title, template_id, status) VALUES ('t389-page', 'P', 'P', '${tpl[0]?.id}', 'draft') RETURNING id::text AS id`,
      )) as { id: string }[];
      const id = pg[0]?.id;
      if (!id) throw new Error("page insert failed");
      return id;
    });

    // Insert + list through the plugin operation (ctx.adminQuery).
    const inserted = await runPluginOperation({
      pluginSlug: "t389-alpha",
      operationName: "add_note",
      args: { body: "hello-admin-schema", pageId },
    });
    expect(inserted.ok).toBe(true);
    const listed = await runPluginOperation({
      pluginSlug: "t389-alpha",
      operationName: "list_notes",
      args: {},
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const rows = listed.value as { body: string; page_id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe("hello-admin-schema");

    // ON DELETE CASCADE: hard-delete the page row; the note follows.
    await withSystemSql(async (tx) => {
      await tx.unsafe(`DELETE FROM pages WHERE id = '${pageId}'`);
    });
    const afterCascade = await runPluginOperation({
      pluginSlug: "t389-alpha",
      operationName: "list_notes",
      args: {},
    });
    expect(afterCascade.ok).toBe(true);
    if (afterCascade.ok) expect(afterCascade.value as unknown[]).toHaveLength(0);
  });

  it("adversarial: cross-plugin access fails — by declaration AND at RLS", async () => {
    await bootstrap({
      infra,
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [
        { definition: makeNotesPlugin("t389-alpha") },
        { definition: makeNotesPlugin("t389-beta") },
      ],
    });

    // Alpha writes a row.
    const pageId = await withSystemSql(async (tx) => {
      const lay = (await tx.unsafe(
        `INSERT INTO layouts (slug, display_name, html, css) VALUES ('t389-lay2', 'L', '<html></html>', '') RETURNING id::text AS id`,
      )) as { id: string }[];
      const tpl = (await tx.unsafe(
        `INSERT INTO templates (slug, display_name, kind, html, css, layout_id) VALUES ('t389-tpl2', 'T', 'home', '<main></main>', '', '${lay[0]?.id}') RETURNING id::text AS id`,
      )) as { id: string }[];
      const pg = (await tx.unsafe(
        `INSERT INTO pages (slug, name, title, template_id, status) VALUES ('t389-page2', 'P', 'P', '${tpl[0]?.id}', 'draft') RETURNING id::text AS id`,
      )) as { id: string }[];
      const id = pg[0]?.id;
      if (!id) throw new Error("page insert failed");
      return id;
    });
    const w = await runPluginOperation({
      pluginSlug: "t389-alpha",
      operationName: "add_note",
      args: { body: "alpha-secret", pageId },
    });
    expect(w.ok).toBe(true);

    // 1. Handle-level: beta's adminQuery refuses undeclared table names.
    const probe = await runPluginOperation({
      pluginSlug: "t389-beta",
      operationName: "probe_foreign_table",
      args: {},
    });
    expect(probe.ok).toBe(false);

    // 2. RLS-level: even with direct SQL under beta's plugin_id session
    // var (simulating an escaped handle), alpha's rows are invisible
    // and unwritable — the per-plugin policy keys on caelo.plugin_id.
    const betaId = loadedPlugins.bySlug("t389-beta")?.pluginId;
    if (!betaId) throw new Error("beta not loaded");
    const sql = new SQL(ADMIN_URL);
    try {
      const visible = await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'plugin'");
        await tx.unsafe(`SET LOCAL caelo.plugin_id = '${betaId}'`);
        return (await tx.unsafe('SELECT COUNT(*)::int AS n FROM "plugin_t389_alpha"."notes"')) as {
          n: number;
        }[];
      });
      expect(visible[0]?.n).toBe(0);

      let writeRefused = false;
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL caelo.actor_kind = 'plugin'");
          await tx.unsafe(`SET LOCAL caelo.plugin_id = '${betaId}'`);
          await tx.unsafe(
            `INSERT INTO "plugin_t389_alpha"."notes" (body, page_id) VALUES ('smuggled', '${pageId}')`,
          );
        });
      } catch {
        writeRefused = true;
      }
      expect(writeRefused).toBe(true);
    } finally {
      await sql.end();
    }
  });

  it("additive evolution: re-bootstrap with a new column adds it in place", async () => {
    await bootstrap({
      infra,
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: makeNotesPlugin("t389-alpha") }],
    });
    resetPluginHost();
    await bootstrap({
      infra,
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: makeNotesPlugin("t389-alpha", { rating: "int" }) }],
    });
    const cols = await withSystemSql(
      async (tx) =>
        (await tx.unsafe(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'plugin_t389_alpha' AND table_name = 'notes'`,
        )) as { column_name: string }[],
    );
    expect(cols.map((c) => c.column_name)).toContain("rating");
  });

  it("ceiling: runtime-authored adminSchema and ref: in cms_public schema are rejected", async () => {
    const tier2Def = definePlugin({
      slug: "t389-tier2-overreach",
      version: "0.1.0",
      tier: 2,
      schema: {},
      adminSchema: { sneaky: { body: "text" } },
      operations: { noop: async () => ({}) },
    });
    const refInPublicDef = definePlugin({
      slug: "t389-ref-in-public",
      version: "0.1.0",
      tier: 1,
      schema: { rows: { page_id: "ref:pages:cascade" } },
      operations: { noop: async () => ({}) },
    });
    const report = await bootstrap({
      infra,
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: tier2Def }, { definition: refInPublicDef }],
    });
    expect(report.loaded).toHaveLength(0);
    expect(report.failed.map((f) => f.slug).sort()).toEqual([
      "t389-ref-in-public",
      "t389-tier2-overreach",
    ]);
    expect(report.failed.find((f) => f.slug === "t389-tier2-overreach")?.reason).toContain(
      "manifest-tier2-cap-leak",
    );
    expect(report.failed.find((f) => f.slug === "t389-ref-in-public")?.reason).toContain(
      "schema-shape",
    );
  });
});
