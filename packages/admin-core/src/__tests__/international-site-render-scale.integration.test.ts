// SPDX-License-Identifier: MPL-2.0

/**
 * #1213 — international-site's render hooks at site scale.
 *
 * Two promises, measured against real Postgres:
 *
 * 1. Completeness. A store read returns at most 1000 rows; the matrix
 *    behind hreflang, sitemap alternates and the language switcher used to
 *    read "the first 1000" variant rows and silently drop the rest, and
 *    other reads threw at 1000. With 1,600 variants every published page
 *    must get its full set, through the same host entry points a build
 *    uses.
 * 2. Cost. One editor preview must not cost more plugin round-trips on a
 *    big site than on a small one: the hooks read the rendered page's own
 *    rows (and its variant group), not the site, and the composition
 *    points of one pass share what they read (`renderId`). Counted as the
 *    Query API operations the adapter runs during the preview's plugin
 *    calls — every plugin store read and every core call is one.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  collectContributions,
  MAIN_RENDER,
  type RenderScope,
  renderInvocation,
  resetPluginHost,
  resolveContentVariants,
  resolveLinkVariants,
  resolveListSources,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { adoptTemplateIntoHomePageType } from "./_template-page-type.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS_CTX: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t1213",
};
const BASE = "https://example.com";
const PFX = "t1213-";
/** 800 groups × 2 languages: past one store read (1000) and one core id batch. */
const BIG_GROUPS = 800;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
let pageTypeId = "";
let pluginId = "";
let seoBaseBefore: string | null = null;

/** Operations the adapter ran while `counting` is on. */
const ran: string[] = [];
let counting = false;

async function sqlSystem<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
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

async function sysOp<T>(name: string, args: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS_CTX, name, args);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function pluginOp<T>(operationName: string, args: unknown): Promise<T> {
  const r = await runPluginOperation({
    invocation: { origin: "system", actorId: SYSTEM_ACTOR_ID },
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
    await tx.unsafe("DELETE FROM plugins WHERE slug = 'international-site'");
    await tx.unsafe(`DELETE FROM pages WHERE slug LIKE '${PFX}%'`);
    await tx.unsafe(`DELETE FROM templates WHERE slug LIKE '${PFX}%'`);
    await tx.unsafe(`DELETE FROM layouts WHERE slug LIKE '${PFX}%'`);
  });
}

/**
 * `groups` English/German page pairs, published, each pair one variant
 * group — inserted in bulk (creating 1,600 pages through pages.create
 * would test pages.create). Returns the pairs.
 */
async function seedGroups(tag: string, groups: number): Promise<{ en: string; de: string }[]> {
  return sqlSystem(async (tx) => {
    const pairs = (await tx.unsafe(
      `WITH n AS (SELECT generate_series(1, ${groups}) AS i),
            en AS (
              INSERT INTO pages (slug, title, short_title, template_id, page_type_id, page_type_confirmed, current_path, status)
              SELECT '${PFX}${tag}-' || i, 'P' || i, 'P' || i, '${templateId}', '${pageTypeId}', true,
                     '/${PFX}${tag}-' || i, 'published' FROM n
              RETURNING id::text AS id, slug),
            de AS (
              INSERT INTO pages (slug, title, short_title, template_id, page_type_id, page_type_confirmed, current_path, status)
              SELECT '${PFX}${tag}-' || i || '-de', 'P' || i, 'P' || i, '${templateId}', '${pageTypeId}', true,
                     '/de/${PFX}${tag}-' || i || '-de', 'published' FROM n
              RETURNING id::text AS id, slug)
       SELECT en.id AS en, de.id AS de FROM en JOIN de ON de.slug = en.slug || '-de'`,
    )) as { en: string; de: string }[];
    await tx.unsafe(`SELECT set_config('caelo.plugin_id', '${pluginId}', true)`);
    const values = pairs.map((p) => `('${p.en}', '${p.de}', gen_random_uuid())`).join(", ");
    // The source joins first: the order hreflang lists the variants in.
    await tx.unsafe(
      `WITH pairs(en, de, g) AS (VALUES ${values})
       INSERT INTO plugin_international_site.page_variants
         (group_id, page_id, locale_code, translation_status, created_at)
       SELECT g, en::uuid, 'en', 'source', now() - interval '1 second' FROM pairs
       UNION ALL
       SELECT g, de::uuid, 'de', 'up_to_date', now() FROM pairs`,
    );
    return pairs;
  });
}

interface PreviewResult {
  readonly calls: string[];
  readonly hreflang: string[];
  readonly switcher: string[];
}

/**
 * The plugin calls one editor preview of `pageId` makes, in one render
 * pass: URL annotations, the switcher list source, the content variants,
 * the link partition for the pages the page references, and the head
 * contributions (hreflang).
 */
async function preview(
  pageId: string,
  referenced: string[],
  chatBranchId: string | null = null,
): Promise<PreviewResult> {
  const scope: RenderScope = { chatBranchId, renderId: crypto.randomUUID() };
  ran.length = 0;
  counting = true;
  try {
    const annotated = await runPluginOperation({
      invocation: renderInvocation(scope),
      pluginSlug: "international-site",
      operationName: "url_annotations",
      args: { pageIds: [pageId] },
    });
    if (!annotated.ok) throw new Error(annotated.error.message);
    const sources = await resolveListSources([pageId], scope, "directory");
    await resolveContentVariants([{ pageId, placements: [] }], scope);
    await resolveLinkVariants([pageId, ...referenced], scope);
    const contributed = await collectContributions([pageId], {
      ...scope,
      siteBaseUrl: BASE,
      pageUrlStyle: "directory",
    });
    return {
      calls: [...ran],
      hreflang: (contributed.head.get(pageId) ?? []).map((e) =>
        e.kind === "link" ? `${e.hreflang} ${e.href}` : JSON.stringify(e),
      ),
      switcher: (sources.get(pageId)?.language_links ?? []).map((i) => String(i.values.locale)),
    };
  } finally {
    counting = false;
  }
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  const runOperation = adapter.runOperation.bind(adapter);
  adapter.runOperation = ((op, ctx, input) => {
    if (counting) ran.push(`${ctx.actorKind}:${op.name}`);
    return runOperation(op, ctx, input);
  }) as typeof adapter.runOperation;
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: intlPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
  const seo = (await sysOp("site_defaults.get_seo", {})) as { siteBaseUrl: string | null };
  seoBaseBefore = seo.siteBaseUrl;
  await sqlSystem((tx) => tx`UPDATE site_defaults SET site_base_url = ${BASE} WHERE id = 1`);
  const ids = await sqlSystem(async (tx) => {
    const lay = (await tx.unsafe(
      `INSERT INTO layouts (slug, display_name, html, css) VALUES ('${PFX}lay', 'L', '<html></html>', '') RETURNING id::text AS id`,
    )) as { id: string }[];
    const tpl = (await tx.unsafe(
      `INSERT INTO templates (slug, display_name, html, css, layout_id) VALUES ('${PFX}tpl', 'T', '<main></main>', '', '${lay[0]?.id}') RETURNING id::text AS id`,
    )) as { id: string }[];
    await adoptTemplateIntoHomePageType(tx, tpl[0]?.id ?? "");
    const type = (await tx.unsafe(
      `SELECT id::text AS id FROM page_types WHERE slug = 'home' AND chat_branch_id IS NULL AND deleted_at IS NULL`,
    )) as { id: string }[];
    const plugin = (await tx.unsafe(
      `SELECT id::text AS id FROM plugins WHERE slug = 'international-site'`,
    )) as { id: string }[];
    return { template: tpl[0]?.id ?? "", pageType: type[0]?.id ?? "", plugin: plugin[0]?.id ?? "" };
  });
  templateId = ids.template;
  pageTypeId = ids.pageType;
  pluginId = ids.plugin;
  if (!templateId || !pageTypeId || !pluginId)
    throw new Error(`seed failed: ${JSON.stringify(ids)}`);
  await pluginOp("set_locales", {
    locales: [
      { code: "en", displayName: "English", urlStrategy: "none", isDefault: true },
      { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
    ],
  });
});

afterAll(async () => {
  await sqlSystem(
    (tx) => tx`UPDATE site_defaults SET site_base_url = ${seoBaseBefore} WHERE id = 1`,
  );
  await cleanup();
  await adapter.close();
});

describe("#1213 — international-site render hooks at scale", () => {
  let small: { en: string; de: string }[] = [];
  let smallPreview: PreviewResult | null = null;

  it("one preview on a small site: hreflang + switcher, and its plugin calls", async () => {
    small = await seedGroups("s", 3);
    const target = small[0];
    if (!target) throw new Error("seed");
    smallPreview = await preview(target.de, [small[1]?.en ?? "", small[2]?.de ?? ""]);
    expect(smallPreview.hreflang).toEqual([
      `en ${BASE}/${PFX}s-1/`,
      `de ${BASE}/de/${PFX}s-1-de/`,
      `x-default ${BASE}/${PFX}s-1/`,
    ]);
    expect(smallPreview.switcher).toEqual(["en", "de"]);
    // The pass shares its reads: 35 operations before #1213 (the registry
    // and the variant rows re-read by every hook, two whole-site
    // pages.list), 14 since. A new read in a render hook shows up here.
    expect(smallPreview.calls.length).toBeLessThanOrEqual(14);
    expect(smallPreview.calls).not.toContain("plugin:pages.list");
  });

  it("the same preview on a site of 1,600+ variants costs exactly as many calls", async () => {
    await seedGroups("b", BIG_GROUPS);
    const target = small[0];
    if (!target || !smallPreview) throw new Error("previous test did not run");
    const big = await preview(target.de, [small[1]?.en ?? "", small[2]?.de ?? ""]);
    expect(big.hreflang).toEqual(smallPreview.hreflang);
    expect(big.switcher).toEqual(smallPreview.switcher);
    expect(big.calls.length).toBe(smallPreview.calls.length);
    expect([...big.calls].sort()).toEqual([...smallPreview.calls].sort());
  });

  it("a later pass reads again: an unpublished variant drops out of hreflang", async () => {
    const target = small[0];
    if (!target) throw new Error("seed");
    await sysOp("pages.set_status", { pageId: target.en, status: "draft" });
    try {
      const after = await preview(target.de, []);
      expect(after.hreflang).toEqual([]);
      expect(after.switcher).toEqual([]);
    } finally {
      await sysOp("pages.set_status", { pageId: target.en, status: "published" });
    }
  });

  it("a build over every page gets every variant's hreflang, switcher and partition", async () => {
    const pages = (await sqlSystem(
      (tx) => tx`SELECT id::text AS id, current_path FROM pages WHERE slug LIKE ${`${PFX}%`}`,
    )) as { id: string; current_path: string }[];
    expect(pages.length).toBeGreaterThanOrEqual(1500);
    const ids = pages.map((p) => p.id);
    const pathOf = new Map(pages.map((p) => [p.id, p.current_path]));

    const contributed = await collectContributions(ids, {
      ...MAIN_RENDER,
      siteBaseUrl: BASE,
      pageUrlStyle: "directory",
    });
    for (const id of ids) {
      const head = contributed.head.get(id) ?? [];
      const langs = head.map((e) => (e.kind === "link" ? e.hreflang : "?"));
      expect(langs).toEqual(["en", "de", "x-default"]);
      const self = head.find((e) => e.kind === "link" && e.href === `${BASE}${pathOf.get(id)}/`);
      expect(self).toBeDefined();
      expect(contributed.sitemap.get(id)?.alternates?.length).toBe(3);
    }

    const sources = await resolveListSources(ids, MAIN_RENDER, "directory");
    for (const id of ids) {
      expect((sources.get(id)?.language_links ?? []).map((i) => i.values.locale)).toEqual([
        "en",
        "de",
      ]);
    }

    const partition = await resolveLinkVariants(ids, MAIN_RENDER);
    expect(partition.size).toBe(ids.length);
    const groups = new Set([...partition.values()].map((v) => v.group));
    expect(groups.size).toBe(ids.length / 2);
  });
  it("a chat's preview sees the chat's pending delete; main does not", async () => {
    const [first, second] = small;
    if (!first || !second) throw new Error("seed");
    const session = await sysOp<{ chatSessionId: string; chatBranchId: string }>(
      "chat.create_session",
      { isolation: "experiment", title: `${PFX}chat` },
    );
    const chatCtx: ExecutionContext = {
      ...SYS_CTX,
      chatBranchId: session.chatBranchId,
      chatTaskId: session.chatSessionId,
    };
    const statuses = async (ctx: ExecutionContext) => {
      const r = await execute(registry, adapter, ctx, "pages.list_statuses", {
        pageIds: [first.en, second.en, second.de],
      });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value;
    };
    try {
      // A chat's delete stays on its branch until the chat is staged.
      const deleted = await execute(registry, adapter, chatCtx, "pages.delete", {
        pageId: second.en,
      });
      if (!deleted.ok) throw new Error(JSON.stringify(deleted.error));
      expect(await statuses(chatCtx)).toEqual({
        statuses: { [first.en]: "published", [second.de]: "published" },
      });
      expect(await statuses(SYS_CTX)).toEqual({
        statuses: { [first.en]: "published", [second.en]: "published", [second.de]: "published" },
      });
      expect((await preview(second.de, [], session.chatBranchId)).switcher).toEqual([]);
      expect((await preview(first.de, [], session.chatBranchId)).switcher).toEqual(["en", "de"]);
      expect((await preview(second.de, [])).switcher).toEqual(["en", "de"]);
    } finally {
      await sqlSystem(
        (tx) => tx`DELETE FROM chat_sessions WHERE id = ${session.chatSessionId}::uuid`,
      );
    }
  });
});
