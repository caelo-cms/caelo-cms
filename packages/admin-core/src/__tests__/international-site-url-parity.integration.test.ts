// SPDX-License-Identifier: MPL-2.0

/**
 * #590 — one URL builder. For every page and locale, the canonical, the
 * sitemap `<loc>`, every hreflang / x-default href and every language
 * switcher href must be byte-identical — for both deploy-target page URL
 * styles and for host-strategy locales — on the static build AND in the
 * editor preview.
 *
 * The regression this pins: the plugin built hreflang as
 * `base + current_path` while core's canonical followed the target's
 * `pageUrlStyle`, so a directory-style site announced `/de/preise` as
 * the alternate of a page whose canonical was `/de/preise/` (and Firebase
 * answered every alternate with a 301).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrap,
  localBuildPluginServices,
  MAIN_RENDER,
  resetPluginHost,
  resolveDataLists,
  runPluginOperation,
  runPluginStaticRender,
} from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext, PageUrlStyle } from "@caelo-cms/shared";
import { runSeoPass } from "@caelo-cms/static-generator";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS_CTX: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t590",
};
const BASE = "https://example.com";
const FR_HOST = "fr.example.com";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let buildDir = "";
let restoreBase: (() => Promise<void>) | null = null;
let restoreLanguage: (() => Promise<void>) | null = null;
let styleBefore: PageUrlStyle | null = null;
/** slug → { id, locale } for the three variants of one group. */
const pages: { slug: string; id: string; locale: string }[] = [];

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

async function setPublishStyle(style: PageUrlStyle): Promise<void> {
  await sqlSystem((tx) => tx`UPDATE deploy_targets SET page_url_style = ${style} WHERE is_default`);
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  await sqlSystem(async (tx) => {
    await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_international_site" CASCADE');
    await tx.unsafe("DELETE FROM redirects WHERE from_path LIKE '%t590-%'");
    await tx.unsafe("DELETE FROM plugins WHERE slug = 'international-site'");
    await tx.unsafe("DELETE FROM pages WHERE slug LIKE 't590-%'");
    await tx.unsafe("DELETE FROM templates WHERE slug LIKE 't590-%'");
  });
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

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  buildDir = mkdtempSync(join(tmpdir(), "t590-build-"));
  restoreBase = await pinSiteBaseUrl(ADMIN_URL, BASE);
  restoreLanguage = await pinSiteLanguage(ADMIN_URL, "en");
  styleBefore = (
    await sqlSystem((tx) => tx`SELECT page_url_style FROM deploy_targets WHERE is_default`)
  )[0]?.page_url_style as PageUrlStyle;

  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: intlPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));

  const tpl = await sysOp<{ templateId: string }>("templates.create", {
    slug: "t590-tpl",
    displayName: "T590",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  await sysOp("template_blocks.set", {
    templateId: tpl.templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  // de rides a path prefix, fr its own host — both URL shapes the
  // builder has to get right.
  await pluginOp("set_locales", {
    locales: [
      { code: "en", displayName: "English", urlStrategy: "none", isDefault: true },
      { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
      {
        code: "fr",
        displayName: "Français",
        urlStrategy: "subdomain",
        urlHost: FR_HOST,
        isDefault: false,
      },
    ],
  });
  const source = await sysOp<{ pageId: string }>("pages.create", {
    slug: "t590-pricing",
    title: "Pricing",
    templateId: tpl.templateId,
  });
  pages.push({ slug: "t590-pricing", id: source.pageId, locale: "en" });
  for (const [locale, slug] of [
    ["de", "t590-preise"],
    ["fr", "t590-prix"],
  ] as const) {
    const v = await pluginOp<{ pageId: string }>("create_variant", {
      sourcePageId: source.pageId,
      localeCode: locale,
      slug,
    });
    pages.push({ slug, id: v.pageId, locale });
  }
  for (const p of pages) await sysOp("pages.set_status", { pageId: p.id, status: "published" });
});

afterAll(async () => {
  if (styleBefore) await setPublishStyle(styleBefore);
  await cleanup();
  await restoreBase?.();
  await restoreLanguage?.();
  rmSync(buildDir, { recursive: true, force: true });
  await adapter.close();
});

function canonicalOf(html: string): string {
  const m = /<link rel="canonical" href="([^"]+)"/.exec(html);
  if (!m?.[1]) throw new Error("no canonical in head");
  return m[1];
}

function hreflangsOf(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)) {
    if (m[1] && m[2]) out[m[1]] = m[2];
  }
  return out;
}

const EXPECTED: Record<PageUrlStyle, Record<string, string>> = {
  directory: {
    en: `${BASE}/t590-pricing/`,
    de: `${BASE}/de/t590-preise/`,
    fr: `https://${FR_HOST}/t590-prix/`,
  },
  "no-extension": {
    en: `${BASE}/t590-pricing`,
    de: `${BASE}/de/t590-preise`,
    fr: `https://${FR_HOST}/t590-prix`,
  },
};

describe("#590 — canonical, sitemap, hreflang and switcher share one URL builder", () => {
  for (const style of ["directory", "no-extension"] as const) {
    it(`every URL of every variant is byte-identical (${style})`, async () => {
      const expected = EXPECTED[style];
      await setPublishStyle(style);

      // --- static build --------------------------------------------------
      const built = pages.map((p) => ({
        pageSlug: p.slug,
        pageTitle: p.slug,
        html: "<!doctype html><html><head><title>x</title></head><body></body></html>",
      }));
      await adapter.withAdminTransaction(SYS_CTX, async (tx) => {
        await runSeoPass({
          tx,
          plugins: localBuildPluginServices,
          buildDir,
          pages: built,
          settings: {
            siteBaseUrl: BASE,
            sitemapEnabled: true,
            siteLanguage: "en",
            organization: {},
          },
          pageUrlStyle: style,
        });
      });
      const allAlternates = { ...expected, "x-default": expected.en };
      for (const p of pages) {
        const html = built.find((b) => b.pageSlug === p.slug)?.html ?? "";
        expect(canonicalOf(html)).toBe(expected[p.locale] as string);
        // Every page announces the full set, and its own entry IS its canonical.
        expect(hreflangsOf(html)).toEqual(allAlternates);
      }

      const sitemap = readFileSync(join(buildDir, "sitemap.xml"), "utf8");
      for (const p of pages) {
        const loc = expected[p.locale] as string;
        const entry = sitemap.split("<url>").find((block) => block.includes(`<loc>${loc}</loc>`));
        expect(entry).toBeDefined();
        for (const [hreflang, href] of Object.entries(allAlternates)) {
          expect(entry).toContain(
            `<xhtml:link rel="alternate" hreflang="${hreflang}" href="${href}" />`,
          );
        }
      }

      // --- language switcher (data list + ready-made markup) -------------
      const lists = await resolveDataLists(
        pages.map((p) => p.id),
        MAIN_RENDER,
        style,
      );
      for (const p of pages) {
        const items = lists.get(p.id)?.language_links ?? [];
        expect(Object.fromEntries(items.map((i) => [i.locale, i.href]))).toEqual(expected);
      }
      const selector = await runPluginStaticRender({
        invocation: { origin: "system", actorId: SYSTEM_ACTOR_ID },
        pluginSlug: "international-site",
        pageId: pages[1]?.id ?? "",
        pageUrlStyle: style,
      });
      for (const href of Object.values(expected)) {
        expect(selector).toContain(`<a href="${href}"`);
      }

      // --- editor preview: same URLs as the build ------------------------
      for (const p of pages) {
        const preview = await sysOp<{ html: string }>("pages.render_preview", { pageId: p.id });
        expect(canonicalOf(preview.html)).toBe(expected[p.locale] as string);
        expect(hreflangsOf(preview.html)).toEqual(allAlternates);
      }
    }, 60_000);
  }

  it("pages.resolve_public_urls refuses AI actors and stale ids with a next step", async () => {
    const ai = await execute(
      registry,
      adapter,
      { ...SYS_CTX, actorKind: "ai" },
      "pages.resolve_public_urls",
      { pageIds: [pages[0]?.id], pageUrlStyle: "directory" },
    );
    expect(ai.ok).toBe(false);
    const stale = await execute(registry, adapter, SYS_CTX, "pages.resolve_public_urls", {
      pageIds: [crypto.randomUUID()],
      pageUrlStyle: "directory",
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(JSON.stringify(stale.error)).toContain("Next step");
  });
});
