// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1212 — the fixture behind the preview cost benchmarks: a site
 * whose page count the test grows, an adapter that reports every
 * statement it runs, and a counter for one `pages.render_preview`.
 *
 * Filler pages are raw rows: seeding 2,000 pages through the ops takes
 * minutes, and what the benchmark measures is the render, not the seed.
 */

import consentPlugin from "@caelo-cms/plugin-consent-manager";
import { bootstrap, resetPluginHost, runPluginOperation } from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

/** The system actor the benchmarks act as. */
export const COST_SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "preview-render-cost",
};

const PLUGIN_SCHEMAS = ["plugin_international_site", "plugin_consent_manager"];

/** One render's statement count, cold (site view not cached) and warm. */
export interface RenderCost {
  readonly cold: number;
  readonly warm: number;
  readonly branchCold: number;
  readonly branchWarm: number;
}

/** A seeded benchmark site. */
export interface CostSite {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  readonly pageId: string;
  /** A branch with no pending changes (a system actor may name any). */
  readonly branchId: string;
  /** Run `fn` in a raw transaction as the system actor (fixture writes). */
  asSystem<T>(fn: (tx: SQL) => Promise<T>): Promise<T>;
  /** Render the page; throws on an error result. */
  render(input: Record<string, unknown>): Promise<{ html: string; missingSlots: string[] }>;
  /** The statements of the last counted render. */
  lastStatements(): readonly string[];
  /** Add filler pages `from` … `to - 1`. */
  seedFillerPages(from: number, to: number): Promise<void>;
  measure(): Promise<RenderCost>;
  close(): Promise<void>;
}

async function asSystem<T>(adminUrl: string, fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(adminUrl);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function dropPluginState(adminUrl: string, publicUrl: string): Promise<void> {
  resetPluginHost();
  await asSystem(adminUrl, async (tx) => {
    for (const schema of PLUGIN_SCHEMAS)
      await tx.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  });
  const pub = new SQL(publicUrl);
  try {
    for (const schema of PLUGIN_SCHEMAS)
      await pub.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await pub.end();
  }
}

/**
 * Seed the benchmark site: 150 filler pages (half published, each with a
 * meta description), one page with a module whose link points at a filler
 * page. With `plugins`, the shipped international-site (en + de) and
 * consent-manager plugins run, as on a production install.
 */
export async function setupCostSite(opts: {
  readonly plugins: boolean;
  /** Connections per pool (default: the test preload's cap). */
  readonly poolMax?: number;
}): Promise<CostSite> {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const publicUrl = process.env.PUBLIC_ADMIN_DATABASE_URL;
  if (!adminUrl || !publicUrl) throw new Error("DB URLs required");
  const restores = [
    await pinSiteBaseUrl(adminUrl, "https://example.com"),
    await pinSiteLanguage(adminUrl, "en"),
  ];
  let counting = false;
  let statements: string[] = [];
  const adapter = new DatabaseAdapter({
    adminDatabaseUrl: adminUrl,
    publicDatabaseUrl: publicUrl,
    ...(opts.poolMax !== undefined ? { poolMax: opts.poolMax } : {}),
    onStatement: (s) => {
      if (counting) statements.push(s);
    },
  });
  const registry = new OperationRegistry();
  registerAdminOps(registry);

  const seedFillerPages = async (from: number, to: number): Promise<void> => {
    await asSystem(adminUrl, async (tx) => {
      const [d] = (await tx`
        SELECT default_template_id::text AS t, default_page_type_id::text AS pt
        FROM site_defaults WHERE id = 1
      `) as { t: string; pt: string }[];
      if (!d) throw new Error("site_defaults seed missing");
      for (let start = from; start < to; start += 500) {
        const end = Math.min(start + 500, to);
        await tx.unsafe(
          `INSERT INTO pages (slug, title, short_title, template_id, page_type_id, status, current_path)
           SELECT 'cost-filler-' || g, 'Filler ' || g, 'Filler ' || g, $1::uuid, $2::uuid,
                  CASE WHEN g % 2 = 0 THEN 'published' ELSE 'draft' END, '/cost-filler-' || g
           FROM generate_series(${start}, ${end - 1}) g`,
          [d.t, d.pt],
        );
      }
      await tx.unsafe(
        `INSERT INTO pages_seo (page_id, meta_description)
         SELECT id, 'About ' || title FROM pages WHERE slug LIKE 'cost-filler-%'
         ON CONFLICT (page_id) DO NOTHING`,
      );
    });
  };

  if (opts.plugins) {
    await dropPluginState(adminUrl, publicUrl);
    const report = await bootstrap({
      infra: { adapter, registry },
      pluginsRoot: "/dev/null/unused",
      systemActorId: COST_SYSTEM.actorId,
      testPlugins: [{ definition: intlPlugin }, { definition: consentPlugin }],
    });
    if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
    const locales = await runPluginOperation({
      invocation: { origin: "system", actorId: COST_SYSTEM.actorId },
      pluginSlug: "international-site",
      operationName: "set_locales",
      args: {
        locales: [
          { code: "en", displayName: "English", urlStrategy: "subdirectory", isDefault: true },
          { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
        ],
      },
    });
    if (!locales.ok) throw new Error(`set_locales: ${locales.error.message}`);
  }

  await seedFillerPages(0, 150);
  const sysOp = async <T>(name: string, args: unknown): Promise<T> => {
    const r = await execute(registry, adapter, COST_SYSTEM, name, args);
    if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
    return r.value as T;
  };
  const mod = await sysOp<{ moduleId: string }>("modules.create", {
    slug: "cost-hero",
    displayName: "Cost hero",
    html: `<section class="hero"><h1>{{hero_title}}</h1><a href="{{cta_href}}">Go</a></section>`,
    css: ".hero{padding:1rem}",
    fields: [
      { name: "hero_title", label: "Title", kind: "text", default: "Hello" },
      { name: "cta_href", label: "Link", kind: "link", default: "/cost-filler-2" },
    ],
  });
  const page = await sysOp<{ pageId: string }>("pages.create", {
    slug: "cost-page",
    title: "Cost page",
  });
  await sysOp("pages.set_modules", {
    pageId: page.pageId,
    blocks: [{ blockName: "content", moduleIds: [mod.moduleId] }],
  });
  // A system actor may name any branch; one with no pending changes still
  // runs every branch overlay read.
  const branchId = crypto.randomUUID();

  const count = async (input: Record<string, unknown>): Promise<number> => {
    statements = [];
    counting = true;
    const r = await execute(registry, adapter, COST_SYSTEM, "pages.render_preview", input);
    counting = false;
    if (!r.ok) throw new Error(`render failed: ${JSON.stringify(r.error)}`);
    return statements.length;
  };

  return {
    adapter,
    registry,
    pageId: page.pageId,
    branchId,
    asSystem: (fn) => asSystem(adminUrl, fn),
    render: async (input) => {
      const r = await execute(registry, adapter, COST_SYSTEM, "pages.render_preview", input);
      if (!r.ok) throw new Error(`render failed: ${JSON.stringify(r.error)}`);
      return r.value as { html: string; missingSlots: string[] };
    },
    lastStatements: () => statements,
    seedFillerPages,
    measure: async () => {
      const cold = await count({ pageId: page.pageId });
      const warm = await count({ pageId: page.pageId });
      const branchCold = await count({ pageId: page.pageId, chatBranchId: branchId });
      const branchWarm = await count({ pageId: page.pageId, chatBranchId: branchId });
      return { cold, warm, branchCold, branchWarm };
    },
    close: async () => {
      if (opts.plugins) await dropPluginState(adminUrl, publicUrl);
      for (const restore of restores.reverse()) await restore();
      await adapter.close();
    },
  };
}
