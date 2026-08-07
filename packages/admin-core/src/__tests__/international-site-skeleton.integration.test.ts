// SPDX-License-Identifier: MPL-2.0

/**
 * #394 — the international-site plugin skeleton proves the Phase-B
 * foundation: it activates on a fresh stack through the full verify
 * pipeline, its cms_admin schema is provisioned with FORCE RLS, its
 * URL-slot claims register — and a test double claiming `path-prefix`
 * triggers the activation-time conflict error naming the holder.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  loadedPlugins,
  resetPluginHost,
  urlContributionsRegistry,
} from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function cleanup(): Promise<void> {
  resetPluginHost();
  const sql = new SQL(ADMIN_URL);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_international_site" CASCADE');
      await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (
        SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug IN ('international-site', 't394-rival'))
      )`);
      await tx.unsafe(
        "DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug IN ('international-site', 't394-rival'))",
      );
      await tx.unsafe("DELETE FROM plugins WHERE slug IN ('international-site', 't394-rival')");
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

describe("#394 — international-site skeleton on the foundation", () => {
  it("activates fresh: verified load, provisioned RLS schema, slot claims, empty-registry annotations", async () => {
    const report = await bootstrap({
      infra: { adapter, registry },
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: intlPlugin }],
    });
    expect(report.failed).toEqual([]);
    expect(report.loaded.map((l) => l.slug)).toEqual(["international-site"]);
    expect(loadedPlugins.bySlug("international-site")?.provenance).toBe("release-signed");

    // Schema provisioned in cms_admin with FORCE RLS on every table.
    const sql = new SQL(ADMIN_URL);
    try {
      const meta = await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        return (await tx.unsafe(
          `SELECT c.relname, c.relforcerowsecurity
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'plugin_international_site' AND c.relkind = 'r'
           ORDER BY c.relname`,
        )) as { relname: string; relforcerowsecurity: boolean }[];
      });
      expect(meta.map((m) => m.relname)).toEqual([
        "glossary",
        "locales",
        "page_variants",
        "settings",
        "style_guides",
      ]);
      expect(meta.every((m) => m.relforcerowsecurity)).toBe(true);
    } finally {
      await sql.end();
    }

    // Slot claims registered.
    expect(urlContributionsRegistry.bySlot("path-prefix")?.pluginSlug).toBe("international-site");
    expect(urlContributionsRegistry.bySlot("host")?.pluginSlug).toBe("international-site");

    // With no locales registered, pages compose bare (zero-diff retrofit).
    const { collectUrlAnnotations } = await import("@caelo-cms/plugin-host");
    const annotations = await collectUrlAnnotations(["00000000-0000-4000-8000-000000000001"]);
    expect(annotations.get("00000000-0000-4000-8000-000000000001")).toEqual({});
  });

  it("a rival claiming path-prefix fails activation naming international-site", async () => {
    const rival = definePlugin({
      slug: "t394-rival",
      version: "0.1.0",
      tier: 1,
      schema: {},
      operations: { noop: async () => ({}) },
      urlContributions: [
        {
          slot: "path-prefix",
          encode: () => [],
          decode: () => null,
        },
      ],
    });
    const report = await bootstrap({
      infra: { adapter, registry },
      pluginsRoot: "/dev/null/unused",
      systemActorId: SYSTEM_ACTOR_ID,
      testPlugins: [{ definition: intlPlugin }, { definition: rival }],
    });
    expect(report.loaded.map((l) => l.slug)).toEqual(["international-site"]);
    expect(report.failed[0]?.slug).toBe("t394-rival");
    expect(report.failed[0]?.reason).toContain('already claimed by plugin "international-site"');
  });
});
