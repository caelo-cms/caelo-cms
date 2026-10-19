// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout E) — international-site's link hook: chrome variants
 * stored before rollout C hold literal paths in their own values. The
 * link migration converts them through the hook (the plugin names the
 * rows, core converts with its canonicaliser), snapshotted with the
 * migration and reverted with it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { bootstrap, resetPluginHost, runPluginOperation } from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: SYSTEM_ACTOR, actorKind: "system", requestId: "t724e" };
const PFX = "t724e";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let layoutId = "";
let footerModuleId = "";
let soloId = "";

async function sqlSystem<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx);
    });
  } finally {
    await sql.end();
  }
}

/** Run `fn` inside the plugin's RLS scope (its tables are FORCE-RLS). */
async function asPlugin<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  return sqlSystem(async (tx) => {
    await tx`SELECT set_config('caelo.plugin_id', (SELECT id::text FROM plugins WHERE slug = 'international-site'), true)`;
    return fn(tx);
  });
}

async function sysOp<T>(name: string, args: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS, name, args);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function op<T>(operationName: string, args: unknown): Promise<T> {
  const r = await runPluginOperation({
    invocation: { origin: "system", actorId: SYSTEM_ACTOR },
    pluginSlug: "international-site",
    operationName,
    args,
  });
  if (!r.ok) throw new Error(`${operationName}: ${r.error.kind}: ${r.error.message}`);
  return r.value as T;
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  await sqlSystem(async (tx) => {
    await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_international_site" CASCADE');
    await tx`DELETE FROM link_migration_runs`;
    await tx`DELETE FROM plugins WHERE slug = 'international-site'`;
    await tx.unsafe(
      `DELETE FROM layout_modules WHERE layout_id IN (SELECT id FROM layouts WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(
      `DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM pages WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM modules WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM templates WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(`DELETE FROM layouts WHERE slug LIKE '${PFX}-%'`);
  });
}

async function variantValues(): Promise<{ nav: { label: string; href: string }[] }> {
  const rows = (await asPlugin(
    (tx) =>
      tx`SELECT "values"::text AS v FROM plugin_international_site.chrome_variants WHERE locale_code = 'de'`,
  )) as { v: string }[];
  return JSON.parse(rows[0]?.v ?? "null");
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR,
    testPlugins: [{ definition: intlPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));

  layoutId = (
    await sysOp<{ layoutId: string }>("layouts.create", {
      slug: `${PFX}-layout`,
      displayName: "T724E layout",
      html: '<body><caelo-slot name="content"></caelo-slot><caelo-slot name="footer"></caelo-slot></body>',
      css: "",
      blocks: [
        { name: "content", displayName: "Content", position: 0 },
        { name: "footer", displayName: "Footer", position: 1 },
      ],
    })
  ).layoutId;
  const { templateId } = await sysOp<{ templateId: string }>("templates.create", {
    slug: `${PFX}-tpl`,
    displayName: "T724E",
    html: '<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>',
    css: "",
    layoutId,
  });
  soloId = (
    await sysOp<{ pageId: string }>("pages.create", {
      slug: `${PFX}-solo`,
      title: "Solo",
      templateId,
    })
  ).pageId;
  footerModuleId = (
    await sysOp<{ moduleId: string }>("modules.create", {
      slug: `${PFX}-footer`,
      displayName: "T724E footer",
      html: '<footer>{{#nav}}<a href="{{href}}">{{label}}</a>{{/nav}}</footer>',
      css: "",
      js: "",
      fields: [{ name: "nav", kind: "link-list", label: "Menu", default: [] }],
    })
  ).moduleId;
  await sysOp("layout_modules.set", { layoutId, blockName: "footer", moduleIds: [footerModuleId] });
  await op("set_locales", {
    locales: [
      { code: "en", displayName: "English", urlStrategy: "none", isDefault: true },
      { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
    ],
  });
  await op("set_chrome_variants", {
    variants: [
      {
        targetKey: `layout:${layoutId}:footer:0`,
        localeCode: "de",
        values: { nav: [{ label: "Kontakt", href: `/${PFX}-solo` }] },
      },
    ],
  });
  // The pre-rollout-C state: the variant stored the literal path.
  await asPlugin(
    (tx) => tx`UPDATE plugin_international_site.chrome_variants
                  SET "values" = ${JSON.stringify({
                    nav: [
                      { label: "Kontakt", href: `/${PFX}-solo` },
                      { label: "Alt", href: `/${PFX}-gone` },
                    ],
                  })}::text::jsonb
                WHERE locale_code = 'de'`,
  );
}, 60_000);

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

describe("international-site link hook", () => {
  it("names its chrome variants; the migration converts them and reports what matches no page", async () => {
    const out = await sysOp<{
      run: { runId: string; counts: Record<string, number> };
      unresolved: { value: string; surface: string; label: string }[];
    }>("links.migrate_to_references", {});
    expect(out.run.counts["plugin:international-site"]).toBe(1);
    expect((await variantValues()).nav).toEqual([
      { label: "Kontakt", href: `caelo:page/${soloId}` },
      { label: "Alt", href: `/${PFX}-gone` },
    ]);
    const gone = out.unresolved.find((u) => u.value === `/${PFX}-gone`);
    expect(gone?.surface).toBe("plugin:international-site");
    expect(gone?.label).toContain("de version of");

    await sysOp("links.revert_migration", { runId: out.run.runId });
    expect((await variantValues()).nav[0]?.href).toBe(`/${PFX}-solo`);
  });
});
