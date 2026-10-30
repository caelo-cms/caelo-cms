// SPDX-License-Identifier: MPL-2.0

/**
 * #1223 — the editor preview's `list-resolve` call costs what its page
 * costs, not what the site costs.
 *
 * A page in German renders a shared menu, a local list of its own
 * (an instance shared with its English source) and a page property. The
 * preview asks international-site for the German overlay only, scoped to
 * what that page can show; the counted Query API operations and SQL
 * statements of that call are the same on a small site and on one with
 * 1,600 more variants. The scoped answer is the whole-site answer for
 * every address in the scope (golden comparison against the unscoped
 * call a build makes), the preview shows the translations, and a page
 * that renders no list asks nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  drainChangeConsumers,
  pluginWorkerScheduler,
  renderInvocation,
  resetPluginHost,
  runPluginOperation,
  stopRuntimeHeartbeat,
} from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { adoptTemplateIntoDefaultPageType } from "./_template-page-type.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: "t1223" };
const PFX = "t1223";
const E = (n: number) => `00000000-0000-4000-9000-0000000122${String(n).padStart(2, "0")}`;
/** 800 groups × 2 languages: past one store read (1000) and one core id batch. */
const BIG_GROUPS = 800;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
const restores: (() => Promise<void>)[] = [];
const ids = { en: "", de: "", about: "", plain: "", list: "", ci: "", template: "", type: "" };

/** Scripted translator: "DE:<source>" for every offered path. */
type Schema = {
  properties: {
    targets: {
      items: {
        anyOf: Array<{
          properties: { target: { enum: string[] }; strings: { required: string[] } };
        }>;
      };
    };
  };
};
const scriptedProvider = {
  complete: async () => {
    throw new Error("translations use generateObject");
  },
  generateObject: async (opts: {
    messages: ReadonlyArray<{ content: string }>;
    jsonSchema: Record<string, unknown>;
  }) => {
    const user = opts.messages[0]?.content ?? "";
    const source = new Map<string, string>();
    for (const section of user.split("### Target ").slice(1)) {
      const id = section.slice(0, section.indexOf(" "));
      for (const m of section.matchAll(/([^\n]+):\n```\n([\s\S]*?)\n```/g)) {
        if (m[1] && m[2] !== undefined) source.set(`${id}|${m[1]}`, m[2]);
      }
    }
    const targets = (opts.jsonSchema as Schema).properties.targets.items.anyOf.map((v) => {
      const id = v.properties.target.enum[0] ?? "";
      const strings: Record<string, string> = {};
      for (const path of v.properties.strings.required) {
        strings[path] = `DE:${source.get(`${id}|${path}`) ?? ""}`;
      }
      return { target: id, strings };
    });
    return { object: { targets }, inputTokens: 1, outputTokens: 1 };
  },
};

/** What the counters saw during one list_resolve call of the plugin. */
interface ListResolveCall {
  readonly args: { variants: string[]; scope?: Scope };
  readonly ops: string[];
  readonly statements: number;
}
interface Scope {
  listIds: string[];
  contentInstanceIds: string[];
  pageIds: string[];
}
const calls: ListResolveCall[] = [];
let current: { ops: string[]; statements: number } | null = null;

/** international-site with its list_resolve counted (calls, operations, statements). */
const countedPlugin = {
  ...intlPlugin,
  operations: {
    ...intlPlugin.operations,
    list_resolve: async (ctx: unknown, args: unknown) => {
      const seen = { ops: [] as string[], statements: 0 };
      current = seen;
      try {
        const listResolve = intlPlugin.operations.list_resolve as (
          c: unknown,
          a: unknown,
        ) => Promise<unknown>;
        return await listResolve(ctx, args);
      } finally {
        current = null;
        calls.push({ args: args as ListResolveCall["args"], ...seen });
      }
    },
  },
} as typeof intlPlugin;

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

async function sysOp<T>(name: string, args: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS, name, args);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function op<T>(operationName: string, args: unknown = {}): Promise<T> {
  const r = await runPluginOperation({
    invocation: { origin: "system", actorId: SYSTEM_ACTOR_ID },
    pluginSlug: "international-site",
    operationName,
    args,
  });
  if (!r.ok) throw new Error(`${operationName}: ${r.error.kind}: ${r.error.message}`);
  return r.value as T;
}

/** The list_resolve answer as a render asks it (fresh pass, nothing shared). */
async function listResolve(args: unknown): Promise<Overlay> {
  const r = await runPluginOperation({
    invocation: renderInvocation({ chatBranchId: null, renderId: crypto.randomUUID() }),
    pluginSlug: "international-site",
    operationName: "list_resolve",
    args,
  });
  if (!r.ok) throw new Error(`list_resolve: ${r.error.message}`);
  const de = (r.value as { overlays: Record<string, Overlay> }).overlays.de;
  if (!de) throw new Error("no German overlay");
  return de;
}
interface Overlay {
  values: Record<string, unknown>;
  hidden: string[];
}

/**
 * What an instance woken by the change journal does (#1267): run the
 * plugin's change consumer to the end of the journal.
 */
async function tick(): Promise<void> {
  const reports = await drainChangeConsumers({ adapter, registry });
  for (const r of reports) if (r.error) throw new Error(`${r.slug}: ${r.error}`);
}

/** One preview of `pageId`: its HTML and the list_resolve calls it made. */
async function preview(pageId: string): Promise<{ html: string; calls: ListResolveCall[] }> {
  calls.length = 0;
  const r = await sysOp<{ html: string }>("pages.render_preview", { pageId });
  return { html: r.html, calls: [...calls] };
}

function inScope(scope: Scope, address: string): boolean {
  const [kind, id] = address.split("/");
  if (kind === "list") return scope.listIds.includes(id ?? "");
  if (kind === "instance") return scope.contentInstanceIds.includes(id ?? "");
  if (kind === "page") return scope.pageIds.includes(id ?? "");
  return false;
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  await sqlSystem(async (tx) => {
    await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_international_site" CASCADE');
    await tx.unsafe(
      "DELETE FROM plugin_event_cursors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = 'international-site')",
    );
    await tx.unsafe("DELETE FROM plugins WHERE slug = 'international-site'");
    await tx.unsafe(`DELETE FROM redirects WHERE from_path LIKE '%${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM pages WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM modules WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM page_type_snapshots WHERE page_type_id IN (SELECT id FROM page_types WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM page_types WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM templates WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM list_snapshots WHERE list_id IN (SELECT id FROM lists WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM lists WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM list_type_snapshots WHERE list_type_id IN (SELECT id FROM list_types WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM list_types WHERE slug LIKE '${PFX}-%'`);
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_URL,
    onStatement: () => {
      if (current) current.statements += 1;
    },
  });
  const runOperation = adapter.runOperation.bind(adapter);
  adapter.runOperation = ((o, ctx, input) => {
    current?.ops.push(`${ctx.actorKind}:${o.name}`);
    return runOperation(o, ctx, input);
  }) as typeof adapter.runOperation;
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  restores.push(await pinSiteBaseUrl(ADMIN_URL as string, "https://example.com"));
  restores.push(await pinSiteLanguage(ADMIN_URL as string, "en"));
  const report = await bootstrap({
    infra: { adapter, registry, aiProvider: scriptedProvider },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: countedPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
  // The counters see every statement on this adapter: no timed plugin work.
  pluginWorkerScheduler.shutdown();
  stopRuntimeHeartbeat();
  await op("set_locales", {
    locales: [
      { code: "en", displayName: "English", urlStrategy: "subdirectory", isDefault: true },
      { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
    ],
  });

  await sysOp("list_types.upsert_many", {
    listTypes: [
      {
        slug: `${PFX}-nav`,
        name: "Nav",
        purpose: "Test navigation",
        role: "navigation",
        root: { allow: ["entry"] },
        nodes: {
          entry: {
            label: "Entry",
            fields: [
              { name: "label", label: "Label", type: "text", required: true },
              { name: "link", label: "Link", type: "link" },
            ],
          },
        },
      },
      {
        slug: `${PFX}-feat`,
        name: "Features",
        purpose: "Test feature bullets",
        role: "content",
        root: { allow: ["feature"] },
        nodes: {
          feature: {
            label: "Feature",
            fields: [{ name: "title", label: "Title", type: "text", required: true }],
          },
        },
      },
    ],
  });

  await sqlSystem(async (tx) => {
    const tpl = (await tx`
      INSERT INTO templates (slug, display_name, html, layout_id)
      VALUES (${`${PFX}-tpl`}, 'T', '<body><caelo-slot name="content">_</caelo-slot></body>',
              (SELECT id FROM layouts WHERE slug = 'site-default'))
      RETURNING id::text AS id`) as unknown as { id: string }[];
    ids.template = tpl[0]?.id ?? "";
    await adoptTemplateIntoDefaultPageType(tx, ids.template);
    await tx`INSERT INTO template_blocks (template_id, name, display_name, position)
             VALUES (${ids.template}::uuid, 'content', 'Content', 0)`;
    for (const slug of ["pricing", "about", "plain"]) {
      const p = (await tx`
        INSERT INTO pages (slug, short_title, title, template_id, status)
        VALUES (${`${PFX}-${slug}`}, ${slug}, ${slug}, ${ids.template}::uuid, 'published')
        RETURNING id::text AS id`) as unknown as { id: string }[];
      if (slug === "pricing") ids.en = p[0]?.id ?? "";
      else if (slug === "about") ids.about = p[0]?.id ?? "";
      else ids.plain = p[0]?.id ?? "";
    }
  });
  for (const pageId of [ids.en, ids.about, ids.plain]) {
    await sysOp("pages.refresh_current_path", { pageId });
  }
  await sysOp("page_types.upsert_many", {
    pageTypes: [
      {
        slug: `${PFX}-product`,
        name: "Product",
        purpose: "Test products with a tagline",
        templates: [ids.template],
        defaultTemplate: ids.template,
        properties: [{ name: "tagline", label: "Tagline", type: "text" }],
        vocabularies: [],
      },
    ],
  });
  await sysOp("pages.update", {
    pageId: ids.en,
    pageType: `${PFX}-product`,
    properties: { tagline: "Fast" },
  });

  const lists = await sysOp<{ lists: { id: string; slug: string }[] }>("lists.upsert_many", {
    lists: [
      {
        slug: `${PFX}-menu`,
        name: "Main menu",
        purpose: "Test menu",
        type: `${PFX}-nav`,
        items: [
          {
            id: E(1),
            node: "entry",
            values: { label: "Pricing", link: { href: `caelo:page/${ids.en}` } },
          },
          {
            id: E(2),
            node: "entry",
            values: { label: "About", link: { href: `caelo:page/${ids.about}` } },
          },
          {
            id: E(3),
            node: "entry",
            values: { label: "Status", link: { href: "https://status.example.org/" } },
          },
        ],
      },
    ],
  });
  ids.list = lists.lists.find((l) => l.slug === `${PFX}-menu`)?.id ?? "";

  await sqlSystem(async (tx) => {
    const fields = JSON.stringify([
      {
        name: "menu",
        kind: "list",
        listType: `${PFX}-nav`,
        bind: "shared",
        list: `caelo:list/${ids.list}`,
        label: "Menu",
      },
      { name: "features", kind: "list", listType: `${PFX}-feat`, label: "Features" },
    ]);
    const html =
      '<nav class="t1223">{{#menu}}<li>{{label}}</li>{{/menu}}</nav>' +
      '<ul class="t1223-feat">{{#features}}<li>{{title}}</li>{{/features}}</ul>' +
      '<p class="t1223-tag">{{page.props.tagline}}</p>';
    const mod = (await tx`
      INSERT INTO modules (slug, display_name, type, html, fields)
      VALUES (${`${PFX}-nav`}, 'Nav', ${`${PFX}-nav`}, ${html}, ${fields}::text::jsonb)
      RETURNING id::text AS id`) as unknown as { id: string }[];
    const features = JSON.stringify({
      features: [
        { id: E(21), node: "feature", values: { title: "Fast setup" } },
        { id: E(22), node: "feature", values: { title: "No lock-in" } },
      ],
    });
    const ci = (await tx`
      INSERT INTO content_instances (module_id, "values")
      VALUES (${mod[0]?.id}::uuid, ${features}::text::jsonb)
      RETURNING id::text AS id`) as unknown as { id: string }[];
    ids.ci = ci[0]?.id ?? "";
    await tx`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
             VALUES (${ids.en}::uuid, 'content', 0, ${mod[0]?.id}::uuid, ${ids.ci}::uuid, 'synced')`;
    // A page whose module reads no list: its preview asks list-resolve nothing.
    const plainMod = (await tx`
      INSERT INTO modules (slug, display_name, type, html, fields)
      VALUES (${`${PFX}-plain`}, 'Plain', ${`${PFX}-plain`}, '<p class="t1223-plain">{{text}}</p>',
              '[{"name":"text","kind":"text","label":"Text","default":"Hello"}]'::jsonb)
      RETURNING id::text AS id`) as unknown as { id: string }[];
    const plainCi = (await tx`
      INSERT INTO content_instances (module_id, "values") VALUES (${plainMod[0]?.id}::uuid, '{}'::jsonb)
      RETURNING id::text AS id`) as unknown as { id: string }[];
    await tx`INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
             VALUES (${ids.plain}::uuid, 'content', 0, ${plainMod[0]?.id}::uuid, ${plainCi[0]?.id}::uuid, 'unsynced')`;
  });

  const de = await op<{ pageId: string }>("create_variant", {
    sourcePageId: ids.en,
    localeCode: "de",
    slug: `${PFX}-preise`,
  });
  ids.de = de.pageId;
  // The German page shows the same instance as its source (a synced
  // placement): its local list is translated by address.
  await sqlSystem(
    (tx) => tx`UPDATE page_modules SET content_instance_id = ${ids.ci}::uuid, sync_mode = 'synced'
               WHERE page_id = ${ids.de}::uuid`,
  );
  await sysOp("pages.update", { pageId: ids.de, pageType: `${PFX}-product` });
  await sysOp("pages.set_status", { pageId: ids.de, status: "published" });
  await tick();
  await op("translate_chrome", { localeCode: "de" });
});

afterAll(async () => {
  await cleanup();
  for (const restore of restores.reverse()) await restore();
  await adapter.close();
});

/** `groups` English/German page pairs, published, each pair one variant group. */
async function seedGroups(groups: number): Promise<void> {
  await sqlSystem(async (tx) => {
    const pluginId = (
      (await tx`SELECT id::text AS id FROM plugins WHERE slug = 'international-site'`) as {
        id: string;
      }[]
    )[0]?.id;
    const pairs = (await tx.unsafe(
      `WITH n AS (SELECT generate_series(1, ${groups}) AS i),
            d AS (SELECT default_page_type_id AS pt FROM site_defaults WHERE id = 1),
            en AS (
              INSERT INTO pages (slug, title, short_title, template_id, page_type_id, status, current_path)
              SELECT '${PFX}-b-' || i, 'P' || i, 'P' || i, '${ids.template}', d.pt, 'published',
                     '/${PFX}-b-' || i FROM n, d
              RETURNING id::text AS id, slug),
            de AS (
              INSERT INTO pages (slug, title, short_title, template_id, page_type_id, status, current_path)
              SELECT '${PFX}-b-' || i || '-de', 'P' || i, 'P' || i, '${ids.template}', d.pt, 'published',
                     '/de/${PFX}-b-' || i || '-de' FROM n, d
              RETURNING id::text AS id, slug)
       SELECT en.id AS en, de.id AS de FROM en JOIN de ON de.slug = en.slug || '-de'`,
    )) as { en: string; de: string }[];
    await tx.unsafe(`SELECT set_config('caelo.plugin_id', '${pluginId}', true)`);
    const values = pairs.map((p) => `('${p.en}', '${p.de}', gen_random_uuid())`).join(", ");
    await tx.unsafe(
      `WITH pairs(en, de, g) AS (VALUES ${values})
       INSERT INTO plugin_international_site.page_variants
         (group_id, page_id, locale_code, translation_status, created_at)
       SELECT g, en::uuid, 'en', 'source', now() - interval '1 second' FROM pairs
       UNION ALL
       SELECT g, de::uuid, 'de', 'up_to_date', now() FROM pairs`,
    );
  });
}

describe("#1223 — list-resolve per previewed page", () => {
  let small: ListResolveCall | null = null;

  it("the German preview asks for German only, scoped to the page, and shows the translations", async () => {
    const r = await preview(ids.de);
    expect(r.calls.length).toBe(1);
    const call = r.calls[0] as ListResolveCall;
    expect(call.args.variants).toEqual(["de"]);
    expect(call.args.scope?.contentInstanceIds).toEqual([ids.ci]);
    expect(call.args.scope?.listIds).toContain(ids.list);
    expect(call.args.scope?.pageIds).toEqual([ids.de]);
    small = call;
    // About has no German version: its entry is hidden there.
    const nav = /<nav class="t1223"[^>]*>([\s\S]*?)<\/nav>/.exec(r.html)?.[1] ?? "";
    expect([...nav.matchAll(/<li[^>]*>([^<]*)<\/li>/g)].map((m) => m[1])).toEqual([
      "DE:Pricing",
      "DE:Status",
    ]);
    const feat = /<ul class="t1223-feat"[^>]*>([\s\S]*?)<\/ul>/.exec(r.html)?.[1] ?? "";
    expect([...feat.matchAll(/<li[^>]*>([^<]*)<\/li>/g)].map((m) => m[1])).toEqual([
      "DE:Fast setup",
      "DE:No lock-in",
    ]);
    expect(r.html).toContain('<p class="t1223-tag">DE:Fast</p>');
  });

  it("the scoped answer is the whole-site answer for every address in the scope", async () => {
    const scope = small?.args.scope;
    if (!scope) throw new Error("previous test did not run");
    const whole = await listResolve({ variants: ["de"] });
    calls.length = 0;
    const scoped = await listResolve({ variants: ["de"], scope });
    const golden = {
      values: Object.fromEntries(Object.entries(whole.values).filter(([a]) => inScope(scope, a))),
      hidden: whole.hidden.filter((a) => inScope(scope, a)),
    };
    expect(scoped).toEqual(golden);
    // Not vacuous: shared list, local list, page property and a hidden entry.
    expect(Object.keys(scoped.values)).toEqual(
      expect.arrayContaining([
        `list/${ids.list}/item/${E(1)}/label`,
        `instance/${ids.ci}/features/item/${E(21)}/title`,
        `page/${ids.de}/props/tagline`,
      ]),
    );
    expect(scoped.hidden).toContain(`list/${ids.list}/item/${E(2)}`);
  });

  it("the reads it scopes by: pages.list by ids and paths, instances by ids", async () => {
    for (const ctx of [SYS, { ...SYS, chatBranchId: crypto.randomUUID() }]) {
      const r = await execute(registry, adapter, ctx, "pages.list", {
        pageIds: [ids.about],
        paths: [`/${PFX}-pricing/?x=1#top`, "/nowhere"],
      });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      const pages = (r.value as { pages: { id: string }[] }).pages.map((p) => p.id);
      expect(pages.sort()).toEqual([ids.en, ids.about].sort());
    }
    const shared = await sysOp<{ listInstances: unknown[]; sharedInstances: unknown[] }>(
      "pages.list_shared_content",
      { listInstanceIds: [ids.ci] },
    );
    expect(shared.sharedInstances).toEqual([]);
    expect(shared.listInstances).toEqual([
      { contentInstanceId: ids.ci, pageIds: [ids.en, ids.de].sort() },
    ]);
    const instances = await sysOp<{ instances: { id: string }[] }>("content_instances.list", {
      ids: [ids.ci],
    });
    expect(instances.instances.map((i) => i.id)).toEqual([ids.ci]);
  });

  it("a page that renders no list asks list-resolve nothing", async () => {
    const r = await preview(ids.plain);
    expect(r.html).toMatch(/<p class="t1223-plain"[^>]*>Hello<\/p>/);
    expect(r.calls).toEqual([]);
  });

  it("costs exactly as much on a site of 1,600 more variants", async () => {
    if (!small) throw new Error("previous test did not run");
    // The whole-site answer (a build's call) on the small site, for the record.
    await listResolve({ variants: ["de"] });
    const smallWhole = calls.at(-1);
    await seedGroups(BIG_GROUPS);
    const r = await preview(ids.de);
    const big = r.calls[0] as ListResolveCall;
    await listResolve({ variants: ["de"] });
    const bigWhole = calls.at(-1) ?? null;
    console.log(
      "[list-resolve-scale]",
      JSON.stringify({
        scoped: {
          small: [small.ops.length, small.statements],
          big: [big.ops.length, big.statements],
        },
        whole: {
          small: [smallWhole?.ops.length, smallWhole?.statements],
          big: [bigWhole?.ops.length, bigWhole?.statements],
        },
      }),
    );
    expect(big.args).toEqual(small.args);
    expect([...big.ops].sort()).toEqual([...small.ops].sort());
    expect(big.statements).toBe(small.statements);
    // The whole site's answer (what every preview asked for before #1223).
    expect(big.statements).toBeLessThan(bigWhole?.statements ?? 0);
  });
});
