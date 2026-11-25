// SPDX-License-Identifier: MPL-2.0

/**
 * #1632 — the international-site plugin's Stage-audit check costs one
 * site-wide pass plus what each fact batch's pages name.
 *
 * Core calls the plugin's `audit_findings` once for the site rules and
 * once per fact batch (100 pages). Every batch call used to repeat the
 * first call's site-wide reads — `pages.list_shared_content` twice (every
 * placement and synced instance of the site, with their values), every
 * variant row — and the check had ONE 60 s budget for all of its calls.
 * A bilingual site of 299 pages on a db-f1-micro errored in this check on
 * every Stage. Measured on this fixture at 2,000 pages: 43 whole-site
 * `pages.list_shared_content` per audit; with stale planner statistics
 * one of them took 6.5 s (7.8 M buffer hits) and the check ran out of
 * its 60 s locally.
 *
 * Here, on a bilingual site with a layout header and footer, shared
 * (synced) instances, local lists and long pages, through the real plugin
 * and the same check the audit job runs:
 * - the first call reads the site's shared content once, the variant
 *   rows once, and only the instances of modules that hold a local list;
 * - a batch call asks core for the shared content of its own pages only,
 *   and reads variant rows by the pages its facts name;
 * - a batch call costs the same operations and statements on a site six
 *   times larger;
 * - the page-scoped `pages.list_shared_content` answers exactly what the
 *   whole-site answer says about those pages.
 *
 * #1721 — the calls go the way the audit's job sends them, through the
 * admin's handler of its reports: the page list crosses once, with the
 * first call; a batch call carries its own pages, reads the others it
 * names by the audit run (`quality_audits.staged_pages`), and the
 * findings are the same when the batch calls run side by side.
 *
 * Measure another size with `CAELO_AUDIT_SCALE_GROUPS=<language groups>`
 * (the `[audit-scale]` lines print the cost of each call).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  pluginWorkerScheduler,
  resetPluginHost,
  runPluginOperation,
  stopRuntimeHeartbeat,
} from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { StagedPage } from "../quality/checks/check.js";
import {
  collectPluginFindings,
  PLUGIN_AUDIT_BATCH_CONCURRENCY,
  withPluginAuditChecks,
} from "../quality/checks/plugin-findings.js";
import { CheckRegistry } from "../quality/checks/registry.js";
import { runFindingChecks } from "../quality/checks/runner.js";
import { registerAdminOps } from "../register.js";
import { adoptTemplateIntoHomePageType } from "./_template-page-type.js";
import { type AuditReportSent, startRunningAudit } from "./fixtures/running-audit.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: SYSTEM_ACTOR_ID, actorKind: "system", requestId: "t1632" };
const PFX = "t1632";
const BASE = "https://example.com";
/**
 * Language groups (two pages each) of the small site: two fact batches,
 * so a batch's links reach pages outside it, as on every large site.
 */
const SMALL_GROUPS = 60;
/** Groups of the large site: six times the small one, eight fact batches. */
const BIG_GROUPS = Number(process.env.CAELO_AUDIT_SCALE_GROUPS ?? 360);
/** Own placements per page: a hero, a block with a local list, body copy. */
const BODY_MODULES = 4;
/** Text runs of a page's body copy. */
const TEXT_RUNS = 40;
/** Links of a page's body copy to other pages of its language. */
const BODY_LINKS = 5;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
const restores: (() => Promise<void>)[] = [];

/** One operation a call of `audit_findings` ran: its name and input. */
interface OpCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/** What the counters saw during one call of `audit_findings`. */
interface AuditCall {
  readonly batchPages: string[] | null;
  readonly ms: number;
  readonly ops: OpCall[];
  readonly statements: number;
}
const calls: AuditCall[] = [];
let current: { ops: OpCall[]; statements: number } | null = null;

/** international-site with its audit_findings counted (operations, statements, time). */
const countedPlugin = {
  ...intlPlugin,
  operations: {
    ...intlPlugin.operations,
    audit_findings: async (ctx: unknown, args: unknown) => {
      const seen = { ops: [] as OpCall[], statements: 0 };
      current = seen;
      const t0 = performance.now();
      try {
        const run = intlPlugin.operations.audit_findings as (c: unknown, a: unknown) => unknown;
        return await run(ctx, args);
      } finally {
        current = null;
        const facts = (args as { facts?: { pageId: string }[] }).facts;
        calls.push({
          batchPages: facts ? facts.map((f) => f.pageId) : null,
          ms: performance.now() - t0,
          ...seen,
        });
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

async function cleanup(): Promise<void> {
  resetPluginHost();
  await sqlSystem(async (tx) => {
    await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_international_site" CASCADE');
    await tx.unsafe(
      "DELETE FROM plugin_event_cursors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = 'international-site')",
    );
    await tx.unsafe("DELETE FROM plugins WHERE slug = 'international-site'");
    await tx.unsafe(
      `DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM pages WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(
      `DELETE FROM layout_modules WHERE layout_id IN (SELECT id FROM layouts WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM modules WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM templates WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(`DELETE FROM layouts WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM list_type_snapshots WHERE list_type_id IN (SELECT id FROM list_types WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM list_types WHERE slug LIKE '${PFX}-%'`);
  });
}

/** `n` characters of copy that does not compress away, as real copy does not. */
function copy(n: number, seed: string): string {
  let out = "";
  for (let i = 0; out.length < n; i++) {
    out += `${seed} ${new Bun.CryptoHasher("md5").update(`${seed}${i}`).digest("hex")} `;
  }
  return out.slice(0, n);
}

interface Pair {
  readonly en: string;
  readonly de: string;
  readonly enPath: string;
  readonly dePath: string;
}
const pairs: Pair[] = [];
const ids = { template: "", pageType: "", header: "", footer: "", cta: "", ctaEn: "", ctaDe: "" };
/** Modules placed on every page with its own instance. */
const bodyModules: string[] = [];

/**
 * `count` more language groups: an English and a German page each, every
 * page with its own hero, local-list block and body copy, the shared CTA
 * of its language (synced) and both pages in one variant group.
 */
async function addGroups(count: number): Promise<void> {
  const from = pairs.length + 1;
  await sqlSystem(async (tx) => {
    const rows = (await tx.unsafe(
      `WITH n AS (SELECT generate_series(${from}, ${from + count - 1}) AS i),
            en AS (
              INSERT INTO pages (slug, title, short_title, template_id, page_type_id, page_type_confirmed, status, current_path)
              SELECT '${PFX}-p-' || i, 'Page ' || i, 'P' || i, '${ids.template}', '${ids.pageType}', true, 'published',
                     '/${PFX}-p-' || i FROM n
              RETURNING id::text AS id, slug, current_path),
            de AS (
              INSERT INTO pages (slug, title, short_title, template_id, page_type_id, page_type_confirmed, status, current_path)
              SELECT '${PFX}-p-' || i || '-de', 'Seite ' || i, 'S' || i, '${ids.template}', '${ids.pageType}', true, 'published',
                     '/de/${PFX}-p-' || i || '-de' FROM n
              RETURNING id::text AS id, slug, current_path)
       SELECT en.id AS en, de.id AS de, en.current_path AS en_path, de.current_path AS de_path
       FROM en JOIN de ON de.slug = en.slug || '-de' ORDER BY en.slug`,
    )) as { en: string; de: string; en_path: string; de_path: string }[];
    const added = rows.map((r) => ({ en: r.en, de: r.de, enPath: r.en_path, dePath: r.de_path }));
    const pageIds = added.flatMap((p) => [p.en, p.de]);
    const mods = bodyModules.map((m, pos) => `('${m}'::uuid, ${pos})`).join(", ");
    await tx.unsafe(
      `WITH pg AS (SELECT unnest($2::uuid[]) AS id),
            mods(m, pos) AS (VALUES ${mods}),
            slots AS MATERIALIZED (
              SELECT pg.id AS page_id, mods.m, mods.pos, gen_random_uuid() AS ci FROM pg, mods),
            ins AS (
              INSERT INTO content_instances (id, module_id, "values")
              SELECT s.ci, s.m, jsonb_build_object('title', 'Title', 'body', $1::text || s.ci::text,
                     'items', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'node', 'feature',
                       'values', jsonb_build_object('title', 'Fast'))))
              FROM slots s RETURNING id)
       INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
       SELECT s.page_id, 'content', s.pos, s.m, s.ci, 'unsynced' FROM slots s
       WHERE EXISTS (SELECT 1 FROM ins WHERE ins.id = s.ci)`,
      [copy(2048, "pagebody"), pageIds],
    );
    await tx.unsafe(
      `INSERT INTO page_modules (page_id, block_name, position, module_id, content_instance_id, sync_mode)
       SELECT p.id, 'content', ${BODY_MODULES}, '${ids.cta}',
              CASE WHEN p.current_path LIKE '/de/%' THEN '${ids.ctaDe}'::uuid ELSE '${ids.ctaEn}'::uuid END, 'synced'
       FROM pages p WHERE p.id = ANY($1::uuid[])`,
      [pageIds],
    );
    const pluginId = (
      (await tx`SELECT id::text AS id FROM plugins WHERE slug = 'international-site'`) as {
        id: string;
      }[]
    )[0]?.id;
    await tx.unsafe(`SELECT set_config('caelo.plugin_id', '${pluginId}', true)`);
    const values = added.map((p) => `('${p.en}', '${p.de}', gen_random_uuid())`).join(", ");
    await tx.unsafe(
      `WITH pairs(en, de, g) AS (VALUES ${values})
       INSERT INTO plugin_international_site.page_variants
         (group_id, page_id, locale_code, translation_status, created_at)
       SELECT g, en::uuid, 'en', 'source', now() - interval '1 second' FROM pairs
       UNION ALL
       SELECT g, de::uuid, 'de', 'up_to_date', now() FROM pairs`,
    );
    pairs.push(...added);
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
    current?.ops.push({ name: o.name, input: (input ?? {}) as Record<string, unknown> });
    return runOperation(o, ctx, input);
  }) as typeof adapter.runOperation;
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  restores.push(await pinSiteBaseUrl(ADMIN_URL as string, BASE));
  restores.push(await pinSiteLanguage(ADMIN_URL as string, "en"));
  const report = await bootstrap({
    infra: { adapter, registry },
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
    const lay = (await tx.unsafe(
      `INSERT INTO layouts (slug, display_name, html, css)
       VALUES ('${PFX}-lay', 'L', '<html><body><caelo-slot name="header">_</caelo-slot><caelo-slot name="main">_</caelo-slot><caelo-slot name="footer">_</caelo-slot></body></html>', '')
       RETURNING id::text AS id`,
    )) as { id: string }[];
    const layoutId = lay[0]?.id as string;
    const tpl = (await tx.unsafe(
      `INSERT INTO templates (slug, display_name, html, css, layout_id)
       VALUES ('${PFX}-tpl', 'T', '<main><caelo-slot name="content">_</caelo-slot></main>', '', '${layoutId}')
       RETURNING id::text AS id`,
    )) as { id: string }[];
    ids.template = tpl[0]?.id as string;
    await adoptTemplateIntoHomePageType(tx, ids.template);
    await tx.unsafe(
      `INSERT INTO template_blocks (template_id, name, display_name, position) VALUES ('${ids.template}', 'content', 'Content', 0)`,
    );
    const mod = async (slug: string, kind: string, fields: unknown[]): Promise<string> => {
      const r = (await tx.unsafe(
        `INSERT INTO modules (slug, display_name, html, kind, type, fields)
         VALUES ('${PFX}-${slug}', '${slug}', '<div>{{title}}</div>', '${kind}', 'html', $1::text::jsonb)
         RETURNING id::text AS id`,
        [JSON.stringify(fields)],
      )) as { id: string }[];
      return r[0]?.id as string;
    };
    const linkFields = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => [
        { name: `${prefix}_${i}_label`, kind: "text", default: copy(40, `${prefix}${i}`) },
        { name: `${prefix}_${i}_href`, kind: "link", default: `/page-${i}` },
      ]).flat();
    ids.header = await mod("header", "chrome", linkFields("nav", 10));
    ids.footer = await mod("footer", "chrome", linkFields("foot", 20));
    ids.cta = await mod("cta", "cta", [{ name: "title", kind: "text", default: "Talk to us" }]);
    bodyModules.push(
      await mod("hero", "hero", [{ name: "title", kind: "text", default: copy(80, "hero") }]),
      await mod("features", "content", [
        { name: "intro", kind: "richtext", default: copy(1024, "feat") },
        { name: "items", kind: "list", listType: `${PFX}-feat`, bind: "local" },
      ]),
    );
    for (let i = bodyModules.length; i < BODY_MODULES; i++) {
      bodyModules.push(
        await mod(`body-${i}`, "content", [
          { name: "body", kind: "richtext", default: copy(1024, `body${i}`) },
        ]),
      );
    }
    await tx.unsafe(
      `INSERT INTO layout_modules (layout_id, block_name, position, module_id) VALUES
         ('${layoutId}', 'header', 0, '${ids.header}'),
         ('${layoutId}', 'footer', 0, '${ids.footer}')`,
    );
    ids.pageType = (
      (await tx.unsafe(
        `SELECT id::text AS id FROM page_types WHERE slug = 'home' AND chat_branch_id IS NULL AND deleted_at IS NULL`,
      )) as { id: string }[]
    )[0]?.id as string;
    const cta = (await tx.unsafe(
      `INSERT INTO content_instances (module_id, slug, "values")
       VALUES ('${ids.cta}', '${PFX}-cta', '{"title":"Talk to us"}'::jsonb),
              ('${ids.cta}', '${PFX}-cta-de', '{"title":"Sprechen Sie mit uns"}'::jsonb)
       RETURNING id::text AS id`,
    )) as { id: string }[];
    ids.ctaEn = cta[0]?.id as string;
    ids.ctaDe = cta[1]?.id as string;
  });
  await addGroups(SMALL_GROUPS);
  // The site home is the first pair: every language's home is in its group.
  const home = pairs[0] as Pair;
  const before = await sqlSystem(async (tx) => {
    const rows = (await tx.unsafe(
      "SELECT home_page_id::text AS id FROM site_defaults WHERE id = 1",
    )) as { id: string | null }[];
    await tx.unsafe(`UPDATE site_defaults SET home_page_id = '${home.en}' WHERE id = 1`);
    return rows[0]?.id ?? null;
  });
  restores.push(() =>
    sqlSystem(async (tx) => {
      await tx.unsafe("UPDATE site_defaults SET home_page_id = $1::uuid WHERE id = 1", [before]);
    }),
  );
}, 120_000);

afterAll(async () => {
  for (const restore of restores.reverse()) await restore();
  await cleanup();
  await adapter.close();
});

/** The staged build: hreflang, a header menu, long copy with links, a footer. */
function staged(): StagedPage[] {
  const out: StagedPage[] = [];
  for (const [n, p] of pairs.entries()) {
    for (const [lang, path, other] of [
      ["en", p.enPath, p.dePath],
      ["de", p.dePath, p.enPath],
    ] as const) {
      const pathIn = (q: Pair) => (lang === "en" ? q.enPath : q.dePath);
      const menu = pairs
        .slice(0, 10)
        .map((q, i) => `<a href="${pathIn(q)}">${lang === "en" ? "Menu" : "Menü"} ${i}</a>`)
        .join("");
      const footer = pairs
        .slice(10, 20)
        .map((q, i) => `<a href="${pathIn(q)}">${lang === "en" ? "Link" : "Verweis"} ${i}</a>`)
        .join("");
      const alt = `<link rel="alternate" hreflang="en" href="${BASE}${p.enPath}"><link rel="alternate" hreflang="de" href="${BASE}${p.dePath}"><link rel="alternate" hreflang="x-default" href="${BASE}${p.enPath}">`;
      const runs: string[] = [];
      for (let i = 0; i < TEXT_RUNS; i++) {
        runs.push(
          lang === "en"
            ? `<p>Paragraph ${i} of page ${n}: our platform helps teams ship faster with fewer mistakes.</p>`
            : `<p>Absatz ${i} der Seite ${n}: unsere Plattform hilft Teams, schneller zu liefern.</p>`,
        );
        if (i < BODY_LINKS) {
          const q = pairs[(n + i + 1) % pairs.length] as Pair;
          runs.push(`<p><a href="${pathIn(q)}">${lang === "en" ? "Read" : "Lesen"} ${i}</a></p>`);
        }
      }
      out.push({
        pageId: lang === "en" ? p.en : p.de,
        path,
        url: `http://s.test${path}/`,
        html: `<html lang="${lang}"><head><title>${path}</title><link rel="canonical" href="${BASE}${path}">${alt}</head>
<body><header data-caelo-module-id="${ids.header}">${menu}<a href="${other}" hreflang="${lang === "en" ? "de" : "en"}">${lang === "en" ? "Deutsch" : "English"}</a></header>
<main><section data-caelo-module-id="${bodyModules[0]}"><h1>${lang === "en" ? "Welcome" : "Willkommen"} ${n}</h1></section>
<section data-caelo-module-id="${bodyModules[2]}">${runs.join("")}</section>
<section data-caelo-module-id="${ids.cta}"><p>${lang === "en" ? "Talk to us" : "Sprechen Sie mit uns"}</p></section></main>
<footer data-caelo-module-id="${ids.footer}">${footer}<p>All rights reserved</p></footer></body></html>`,
      });
    }
  }
  return out;
}

/** What one audit of {@link audit} saw. */
interface AuditRun {
  /** The plugin's calls, with what each read (counted only one at a time). */
  readonly calls: AuditCall[];
  /** The `plugin-findings` reports the audit's job sent, in order. */
  readonly reports: AuditReportSent[];
  readonly findings: readonly unknown[];
  readonly ms: number;
  readonly pages: number;
}

/**
 * One Stage audit's plugin check over the staged build, its calls made the
 * way the audit's job makes them and answered by the admin's own handler
 * of its reports (#1721), `concurrency` batch calls at a time.
 */
async function audit(concurrency = 1): Promise<AuditRun> {
  const run = await startRunningAudit(ADMIN_URL as string, { adapter, registry }, PFX);
  try {
    const checks = withPluginAuditChecks(new CheckRegistry(), {
      contributors: () => ["international-site"],
      findings: (slug, pages, facts) =>
        collectPluginFindings(run.call(slug), slug, pages, facts, { concurrency }),
      siteUrls: async () => [BASE],
    });
    const pages = staged();
    calls.length = 0;
    const t0 = performance.now();
    const out = await runFindingChecks(checks.findingChecks(), pages, {
      baseUrl: "http://s.test",
      probe: async () => ({ found: true, status: 200 }),
      text: async () => null,
    });
    const ms = performance.now() - t0;
    expect(out.errors).toEqual([]);
    const result = {
      calls: [...calls],
      reports: [...run.reports],
      findings: out.findings,
      ms,
      pages: pages.length,
    };
    console.log(
      "[audit-scale]",
      JSON.stringify({
        pages: result.pages,
        concurrency,
        ms: Math.round(ms),
        calls: result.calls.map((c, i) => ({
          batch: c.batchPages?.length ?? null,
          ops: c.ops.length,
          statements: c.statements,
          ms: Math.round(c.ms),
          reportChars: result.reports[i]?.chars,
        })),
      }),
    );
    return result;
  } finally {
    await run.remove();
  }
}

const sharedReads = (c: AuditCall) => c.ops.filter((o) => o.name === "pages.list_shared_content");
const storeReads = (c: AuditCall, table: string) =>
  c.ops.filter((o) => o.name === "plugin_storage.list" && o.input.table === table);
/** What a batch call may ask core: its pages' shared content, the pages it names and a few rows. */
const BATCH_CORE_OPS = new Set([
  "pages.list_shared_content",
  "quality_audits.staged_pages",
  "site_defaults.get",
  "list_types.list",
  "lists.plugin_source_texts",
  "plugin_storage.list",
]);

describe("#1632 — the international-site audit check per call", () => {
  let small: AuditCall[] = [];
  let smallRun: AuditRun | null = null;

  it("the first call reads each site-wide source once; a batch asks about its own pages", async () => {
    // Once to warm what the host remembers per process (a table's index
    // columns), so this run and the large one count the same statements.
    await audit();
    const r = await audit();
    small = r.calls;
    smallRun = r;
    expect(r.calls.map((c) => c.batchPages === null)).toEqual([true, false, false]);
    const [first, batch] = r.calls as [AuditCall, AuditCall];

    expect(sharedReads(first).map((o) => o.input)).toEqual([{}]);
    expect(storeReads(first, "page_variants").map((o) => o.input.filter)).toEqual([
      { orderBy: "id", orderDir: "asc", limit: 1000 },
    ]);
    for (const o of first.ops.filter((o) => o.name === "content_instances.list")) {
      expect(Object.keys(o.input)).toContain("moduleIds");
    }

    expect(batch.ops.filter((o) => !BATCH_CORE_OPS.has(o.name))).toEqual([]);
    expect(sharedReads(batch).map((o) => o.input)).toEqual([{ onPageIds: batch.batchPages }]);
    for (const o of storeReads(batch, "page_variants")) {
      const filter = o.input.filter as { anyOf?: Record<string, unknown> };
      expect(Object.keys(filter.anyOf ?? {})).toHaveLength(1);
    }
    // #1721 — the batch call carries its own pages and reads the others it
    // names by the audit run, never the page list of the build.
    const [firstReport, batchReport] = r.reports as [AuditReportSent, AuditReportSent];
    expect(firstReport.args.pages).toHaveLength(r.pages);
    expect(batchReport.args.batchPages).toBe("own");
    expect(batchReport.args.pages.map((p) => p.pageId)).toEqual(batch.batchPages ?? []);
    const named = batch.ops.filter((o) => o.name === "quality_audits.staged_pages");
    expect(named.length).toBeGreaterThan(0);
    for (const o of named) expect(o.input.auditRunId).toBeString();
  }, 120_000);

  it("a batch call costs the same operations and statements on a six times larger site", async () => {
    await addGroups(BIG_GROUPS - SMALL_GROUPS);
    const r = await audit();
    const batches = r.calls.filter((c) => c.batchPages !== null);
    expect(batches.length).toBe(Math.ceil((BIG_GROUPS * 2) / 100));
    const smallBatch = small[1] as AuditCall;
    const shape = (c: AuditCall) =>
      c.ops.map((o) => `${o.name}${o.input.table ? `:${String(o.input.table)}` : ""}`).sort();
    for (const b of batches) {
      expect(shape(b)).toEqual(shape(smallBatch));
      expect(b.statements).toBe(smallBatch.statements);
    }
    // One whole-site read of the shared content per audit, however many batches.
    expect(r.calls.flatMap(sharedReads).filter((o) => !("onPageIds" in o.input))).toHaveLength(1);
    // #1721 — the page list crosses once, with the first report: it grows
    // with the site. What a batch's report carries besides its facts (its
    // own pages) does not, per page of the batch (its paths are a digit
    // longer on the large site).
    const firstChars = (a: AuditRun) => (a.reports[0] as AuditReportSent).chars;
    const perBatchPage = (a: AuditRun) =>
      Math.max(
        ...a.reports
          .slice(1)
          .map((x) => JSON.stringify({ ...x.args, facts: undefined }).length / x.args.pages.length),
      );
    expect(firstChars(r)).toBeGreaterThan(5 * firstChars(smallRun as AuditRun));
    expect(perBatchPage(r)).toBeLessThan(1.1 * perBatchPage(smallRun as AuditRun));
    for (const x of r.reports.slice(1)) expect(x.args.pages.length).toBeLessThanOrEqual(100);
  }, 300_000);

  it("#1721 — the findings are the same when the batch calls run side by side", async () => {
    const one = await audit(1);
    const many = await audit(PLUGIN_AUDIT_BATCH_CONCURRENCY);
    expect(many.reports.length).toBe(one.reports.length);
    expect(many.findings).toEqual(one.findings);
    expect(one.findings.length).toBeGreaterThan(0);
  }, 300_000);

  it("#1721 — quality_audits.staged_pages answers a running audit's published pages by id or path", async () => {
    const run = await startRunningAudit(ADMIN_URL as string, { adapter, registry }, `${PFX}-sp`);
    try {
      const a = pairs[0] as Pair;
      const b = pairs[1] as Pair;
      const answer = await sysOp<{ pages: { pageId: string; path: string }[] }>(
        "quality_audits.staged_pages",
        { auditRunId: run.auditRunId, pageIds: [a.en, a.de], paths: [b.dePath, "/no-such-page"] },
      );
      expect(answer.pages.sort((x, y) => x.path.localeCompare(y.path))).toEqual(
        [
          { pageId: a.en, path: a.enPath },
          { pageId: a.de, path: a.dePath },
          { pageId: b.de, path: b.dePath },
        ].sort((x, y) => x.path.localeCompare(y.path)),
      );
      // The handle ends with the run.
      await run.end();
      const ended = await execute(registry, adapter, SYS, "quality_audits.staged_pages", {
        auditRunId: run.auditRunId,
        pageIds: [a.en],
      });
      expect(ended.ok).toBe(false);
      expect(JSON.stringify(ended)).toContain("is passed, not running");
    } finally {
      await run.remove();
    }
  });

  it("pages.list_shared_content for some pages answers what the whole-site answer says about them", async () => {
    type Shared = {
      layoutPlacements: unknown[];
      sharedInstances: { contentInstanceId: string; pageIds: string[] }[];
      listInstances: unknown[];
    };
    const whole = await sysOp<Shared>("pages.list_shared_content", {});
    const some = pairs.slice(3, 6).flatMap((p) => [p.en, p.de]);
    const scoped = await sysOp<Shared>("pages.list_shared_content", { onPageIds: some });
    expect(scoped.layoutPlacements).toEqual(whole.layoutPlacements);
    expect(scoped.listInstances).toEqual([]);
    const expected = whole.sharedInstances
      .map((i) => ({ ...i, pageIds: i.pageIds.filter((p) => some.includes(p)).sort() }))
      .filter((i) => i.pageIds.length > 0);
    expect(scoped.sharedInstances.map((i) => ({ ...i, pageIds: [...i.pageIds].sort() }))).toEqual(
      expected,
    );
    expect(expected.map((i) => i.contentInstanceId).sort()).toEqual([ids.ctaDe, ids.ctaEn].sort());
  });
});
