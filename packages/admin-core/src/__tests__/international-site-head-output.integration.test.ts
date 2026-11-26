// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — the head and sitemap international-site produces for a real
 * multi-language site, byte for byte, on both surfaces: the editor preview
 * (`pages.render_preview`) and the static generator's SEO pass.
 *
 * Pinned when international-site still built its hreflang URLs itself
 * (through `pages.resolve_public_urls`), and kept unchanged when the head
 * vocabulary moved to `pageId` targets whose URLs core builds
 * (docs/dev/external-plugin-brokers.md §6.2): the move must not change one
 * byte of what search engines read. The fixture covers a default language
 * without a prefix, two subdirectory languages (one still a draft), a
 * language on its own host and a page outside any language group.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrap,
  localBuildPluginServices,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { runSeoPass } from "./fixtures/seo-pass.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS_CTX: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t1729h",
};
const BASE = "https://example.com";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let buildDir = "";
let restoreSiteBaseUrl: (() => Promise<void>) | null = null;
let restoreSiteLanguage: (() => Promise<void>) | null = null;
/** The fixture's pages by name, in output order. */
const pages: { name: string; id: string; slug: string }[] = [];

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

async function cleanup(): Promise<void> {
  resetPluginHost();
  await sqlSystem(async (tx) => {
    await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_international_site" CASCADE');
    await tx.unsafe("DELETE FROM redirects WHERE from_path LIKE '%t1729h-%'");
    await tx.unsafe("DELETE FROM plugins WHERE slug = 'international-site'");
    await tx.unsafe("DELETE FROM pages WHERE slug LIKE 't1729h-%'");
    await tx.unsafe("DELETE FROM templates WHERE slug LIKE 't1729h-%'");
  });
}

async function sysOp<T>(name: string, args: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS_CTX, name, args);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function intl<T>(operationName: string, args: unknown): Promise<T> {
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
  buildDir = mkdtempSync(join(tmpdir(), "t1729h-build-"));
  restoreSiteBaseUrl = await pinSiteBaseUrl(ADMIN_URL, BASE);
  restoreSiteLanguage = await pinSiteLanguage(ADMIN_URL, "en");
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: intlPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));

  const { templateId } = await sysOp<{ templateId: string }>("templates.create", {
    pageType: "home",
    slug: "t1729h-tpl",
    displayName: "T1729H",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  await sysOp("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const create = async (slug: string, title: string) =>
    (await sysOp<{ pageId: string }>("pages.create", { slug, title, templateId })).pageId;
  const en = await create("t1729h-pricing", "Pricing");
  const solo = await create("t1729h-solo", "Solo");
  await intl("set_locales", {
    locales: [
      { code: "en", displayName: "English", urlStrategy: "none", isDefault: true },
      { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
      { code: "fr", displayName: "Français", urlStrategy: "subdirectory", isDefault: false },
      {
        code: "es",
        displayName: "Español",
        urlStrategy: "subdomain",
        urlHost: "es.example.com",
        isDefault: false,
      },
    ],
  });
  const variant = async (localeCode: string, slug: string) =>
    (
      await intl<{ pageId: string }>("create_variant", {
        sourcePageId: en,
        localeCode,
        slug,
      })
    ).pageId;
  const de = await variant("de", "t1729h-preise");
  const fr = await variant("fr", "t1729h-prix");
  const es = await variant("es", "t1729h-precios");
  // fr stays a draft: no page names it, and it names the published ones.
  for (const pageId of [en, de, es, solo]) {
    await sysOp("pages.set_status", { pageId, status: "published" });
  }
  pages.push(
    { name: "en", id: en, slug: "t1729h-pricing" },
    { name: "de", id: de, slug: "t1729h-preise" },
    { name: "fr (draft)", id: fr, slug: "t1729h-prix" },
    { name: "es (own host)", id: es, slug: "t1729h-precios" },
    { name: "solo", id: solo, slug: "t1729h-solo" },
  );
}, 60_000);

afterAll(async () => {
  await cleanup();
  await restoreSiteBaseUrl?.();
  await restoreSiteLanguage?.();
  rmSync(buildDir, { recursive: true, force: true });
  await adapter.close();
});

/**
 * The `<html …>` tag and the whole `<head>` of a document. The theme's
 * stylesheet is the seeded theme's, not the plugin's: it is left out so a
 * theme seed change does not read as a head change.
 */
function headOf(html: string): string {
  const open = /<html\b[^>]*>/i.exec(html)?.[0] ?? "(no <html>)";
  const head = /<head\b[^>]*>[\s\S]*?<\/head>/i.exec(html)?.[0] ?? "(no <head>)";
  return `${open}\n${head.replace(/<style data-source="theme">[\s\S]*?<\/style>/, '<style data-source="theme">…</style>')}`;
}

/** What the preview and a build emit for the fixture, as one text. */
async function emitted(): Promise<string> {
  const out: string[] = [];
  for (const page of pages) {
    const preview = await sysOp<{ html: string }>("pages.render_preview", { pageId: page.id });
    out.push(`--- preview ${page.name}`, headOf(preview.html));
  }
  const built = pages.map((p) => ({
    pageId: p.id,
    pageSlug: p.slug,
    html: "<html><head><title>x</title></head><body>b</body></html>",
  }));
  await adapter.withAdminTransaction(SYS_CTX, (tx) =>
    runSeoPass({
      tx,
      plugins: localBuildPluginServices,
      buildDir,
      mediaRoot: buildDir,
      pages: built,
      settings: { siteBaseUrl: BASE, sitemapEnabled: true, siteLanguage: "en", organization: {} },
      pageUrlStyle: "directory",
      notFoundPageId: null,
    }),
  );
  built.forEach((b, i) => {
    out.push(`--- build ${pages[i]?.name}`, headOf(b.html));
  });
  // The sitemap's dates follow the clock; everything else is pinned.
  const sitemap = readFileSync(join(buildDir, "sitemap.xml"), "utf8")
    .split("\n")
    .filter((line) => !line.includes("<lastmod>"))
    .filter((line, i, all) => !line.includes("<url>") || all[i + 1]?.includes("t1729h-"))
    .join("\n");
  out.push("--- sitemap", sitemap);
  return out.join("\n");
}

describe("#1729 — international-site's head and sitemap output", () => {
  it("is byte-identical on a multi-language site", async () => {
    const text = await emitted();
    expect(text).toBe(EXPECTED);
  }, 60_000);
});

const EXPECTED = `--- preview en
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pricing</title>
<link rel="canonical" href="https://example.com/t1729h-pricing/" />
<link rel="alternate" type="application/atom+xml" title="example.com" href="https://example.com/feed.xml" />
<meta property="og:title" content="Pricing" />
<meta property="og:type" content="website" />
<meta property="og:url" content="https://example.com/t1729h-pricing/" />
<meta name="twitter:card" content="summary" />
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Pricing","url":"https://example.com/t1729h-pricing/"}</script>
<link rel="alternate" hreflang="de" href="https://example.com/de/t1729h-preise/" />
<link rel="alternate" hreflang="en" href="https://example.com/t1729h-pricing/" />
<link rel="alternate" hreflang="es" href="https://es.example.com/t1729h-precios/" />
<link rel="alternate" hreflang="x-default" href="https://example.com/t1729h-pricing/" />
<style data-source="theme">…</style><style data-source="base">*,*::before,*::after{box-sizing:border-box}body{margin:0}img,picture,video,canvas,svg{display:block;max-width:100%}input,button,textarea,select{font:inherit}body{font-family:var(--font-body,system-ui,sans-serif)}</style></head>
--- preview de
<html lang="de">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pricing</title>
<link rel="canonical" href="https://example.com/de/t1729h-preise/" />
<link rel="alternate" type="application/atom+xml" title="example.com" href="https://example.com/feed.xml" />
<meta property="og:title" content="Pricing" />
<meta property="og:type" content="website" />
<meta property="og:url" content="https://example.com/de/t1729h-preise/" />
<meta name="twitter:card" content="summary" />
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Pricing","url":"https://example.com/de/t1729h-preise/"}</script>
<link rel="alternate" hreflang="de" href="https://example.com/de/t1729h-preise/" />
<link rel="alternate" hreflang="en" href="https://example.com/t1729h-pricing/" />
<link rel="alternate" hreflang="es" href="https://es.example.com/t1729h-precios/" />
<link rel="alternate" hreflang="x-default" href="https://example.com/t1729h-pricing/" />
<style data-source="theme">…</style><style data-source="base">*,*::before,*::after{box-sizing:border-box}body{margin:0}img,picture,video,canvas,svg{display:block;max-width:100%}input,button,textarea,select{font:inherit}body{font-family:var(--font-body,system-ui,sans-serif)}</style></head>
--- preview fr (draft)
<html lang="fr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pricing</title>
<link rel="canonical" href="https://example.com/fr/t1729h-prix/" />
<link rel="alternate" type="application/atom+xml" title="example.com" href="https://example.com/feed.xml" />
<meta property="og:title" content="Pricing" />
<meta property="og:type" content="website" />
<meta property="og:url" content="https://example.com/fr/t1729h-prix/" />
<meta name="twitter:card" content="summary" />
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Pricing","url":"https://example.com/fr/t1729h-prix/"}</script>
<link rel="alternate" hreflang="de" href="https://example.com/de/t1729h-preise/" />
<link rel="alternate" hreflang="en" href="https://example.com/t1729h-pricing/" />
<link rel="alternate" hreflang="es" href="https://es.example.com/t1729h-precios/" />
<link rel="alternate" hreflang="x-default" href="https://example.com/t1729h-pricing/" />
<style data-source="theme">…</style><style data-source="base">*,*::before,*::after{box-sizing:border-box}body{margin:0}img,picture,video,canvas,svg{display:block;max-width:100%}input,button,textarea,select{font:inherit}body{font-family:var(--font-body,system-ui,sans-serif)}</style></head>
--- preview es (own host)
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pricing</title>
<link rel="canonical" href="https://es.example.com/t1729h-precios/" />
<link rel="alternate" type="application/atom+xml" title="example.com" href="https://example.com/feed.xml" />
<meta property="og:title" content="Pricing" />
<meta property="og:type" content="website" />
<meta property="og:url" content="https://es.example.com/t1729h-precios/" />
<meta name="twitter:card" content="summary" />
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Pricing","url":"https://es.example.com/t1729h-precios/"}</script>
<link rel="alternate" hreflang="de" href="https://example.com/de/t1729h-preise/" />
<link rel="alternate" hreflang="en" href="https://example.com/t1729h-pricing/" />
<link rel="alternate" hreflang="es" href="https://es.example.com/t1729h-precios/" />
<link rel="alternate" hreflang="x-default" href="https://example.com/t1729h-pricing/" />
<style data-source="theme">…</style><style data-source="base">*,*::before,*::after{box-sizing:border-box}body{margin:0}img,picture,video,canvas,svg{display:block;max-width:100%}input,button,textarea,select{font:inherit}body{font-family:var(--font-body,system-ui,sans-serif)}</style></head>
--- preview solo
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Solo</title>
<link rel="canonical" href="https://example.com/t1729h-solo/" />
<link rel="alternate" type="application/atom+xml" title="example.com" href="https://example.com/feed.xml" />
<meta property="og:title" content="Solo" />
<meta property="og:type" content="website" />
<meta property="og:url" content="https://example.com/t1729h-solo/" />
<meta name="twitter:card" content="summary" />
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Solo","url":"https://example.com/t1729h-solo/"}</script>
<style data-source="theme">…</style><style data-source="base">*,*::before,*::after{box-sizing:border-box}body{margin:0}img,picture,video,canvas,svg{display:block;max-width:100%}input,button,textarea,select{font:inherit}body{font-family:var(--font-body,system-ui,sans-serif)}</style></head>
--- build en
<html lang="en">
<head>
<title>Pricing</title>
<link rel="canonical" href="https://example.com/t1729h-pricing/" />
<meta property="og:title" content="Pricing" />
<meta property="og:type" content="website" />
<meta property="og:url" content="https://example.com/t1729h-pricing/" />
<meta name="twitter:card" content="summary" />
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Pricing","url":"https://example.com/t1729h-pricing/"}</script>
<link rel="alternate" hreflang="de" href="https://example.com/de/t1729h-preise/" />
<link rel="alternate" hreflang="en" href="https://example.com/t1729h-pricing/" />
<link rel="alternate" hreflang="es" href="https://es.example.com/t1729h-precios/" />
<link rel="alternate" hreflang="x-default" href="https://example.com/t1729h-pricing/" />
</head>
--- build de
<html lang="de">
<head>
<title>Pricing</title>
<link rel="canonical" href="https://example.com/de/t1729h-preise/" />
<meta property="og:title" content="Pricing" />
<meta property="og:type" content="website" />
<meta property="og:url" content="https://example.com/de/t1729h-preise/" />
<meta name="twitter:card" content="summary" />
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Pricing","url":"https://example.com/de/t1729h-preise/"}</script>
<link rel="alternate" hreflang="de" href="https://example.com/de/t1729h-preise/" />
<link rel="alternate" hreflang="en" href="https://example.com/t1729h-pricing/" />
<link rel="alternate" hreflang="es" href="https://es.example.com/t1729h-precios/" />
<link rel="alternate" hreflang="x-default" href="https://example.com/t1729h-pricing/" />
</head>
--- build fr (draft)
<html lang="fr">
<head>
<title>Pricing</title>
<link rel="canonical" href="https://example.com/fr/t1729h-prix/" />
<meta property="og:title" content="Pricing" />
<meta property="og:type" content="website" />
<meta property="og:url" content="https://example.com/fr/t1729h-prix/" />
<meta name="twitter:card" content="summary" />
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Pricing","url":"https://example.com/fr/t1729h-prix/"}</script>
<link rel="alternate" hreflang="de" href="https://example.com/de/t1729h-preise/" />
<link rel="alternate" hreflang="en" href="https://example.com/t1729h-pricing/" />
<link rel="alternate" hreflang="es" href="https://es.example.com/t1729h-precios/" />
<link rel="alternate" hreflang="x-default" href="https://example.com/t1729h-pricing/" />
</head>
--- build es (own host)
<html lang="es">
<head>
<title>Pricing</title>
<link rel="canonical" href="https://es.example.com/t1729h-precios/" />
<meta property="og:title" content="Pricing" />
<meta property="og:type" content="website" />
<meta property="og:url" content="https://es.example.com/t1729h-precios/" />
<meta name="twitter:card" content="summary" />
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Pricing","url":"https://es.example.com/t1729h-precios/"}</script>
<link rel="alternate" hreflang="de" href="https://example.com/de/t1729h-preise/" />
<link rel="alternate" hreflang="en" href="https://example.com/t1729h-pricing/" />
<link rel="alternate" hreflang="es" href="https://es.example.com/t1729h-precios/" />
<link rel="alternate" hreflang="x-default" href="https://example.com/t1729h-pricing/" />
</head>
--- build solo
<html lang="en">
<head>
<title>Solo</title>
<link rel="canonical" href="https://example.com/t1729h-solo/" />
<meta property="og:title" content="Solo" />
<meta property="og:type" content="website" />
<meta property="og:url" content="https://example.com/t1729h-solo/" />
<meta name="twitter:card" content="summary" />
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Solo","url":"https://example.com/t1729h-solo/"}</script>
</head>
--- sitemap
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url>
    <loc>https://example.com/t1729h-pricing/</loc>
    <xhtml:link rel="alternate" hreflang="de" href="https://example.com/de/t1729h-preise/" />
    <xhtml:link rel="alternate" hreflang="en" href="https://example.com/t1729h-pricing/" />
    <xhtml:link rel="alternate" hreflang="es" href="https://es.example.com/t1729h-precios/" />
    <xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/t1729h-pricing/" />
    <changefreq>weekly</changefreq>
    <priority>0.5</priority>
  </url>
  <url>
    <loc>https://example.com/de/t1729h-preise/</loc>
    <xhtml:link rel="alternate" hreflang="de" href="https://example.com/de/t1729h-preise/" />
    <xhtml:link rel="alternate" hreflang="en" href="https://example.com/t1729h-pricing/" />
    <xhtml:link rel="alternate" hreflang="es" href="https://es.example.com/t1729h-precios/" />
    <xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/t1729h-pricing/" />
    <changefreq>weekly</changefreq>
    <priority>0.5</priority>
  </url>
  <url>
    <loc>https://example.com/fr/t1729h-prix/</loc>
    <xhtml:link rel="alternate" hreflang="de" href="https://example.com/de/t1729h-preise/" />
    <xhtml:link rel="alternate" hreflang="en" href="https://example.com/t1729h-pricing/" />
    <xhtml:link rel="alternate" hreflang="es" href="https://es.example.com/t1729h-precios/" />
    <xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/t1729h-pricing/" />
    <changefreq>weekly</changefreq>
    <priority>0.5</priority>
  </url>
  <url>
    <loc>https://es.example.com/t1729h-precios/</loc>
    <xhtml:link rel="alternate" hreflang="de" href="https://example.com/de/t1729h-preise/" />
    <xhtml:link rel="alternate" hreflang="en" href="https://example.com/t1729h-pricing/" />
    <xhtml:link rel="alternate" hreflang="es" href="https://es.example.com/t1729h-precios/" />
    <xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/t1729h-pricing/" />
    <changefreq>weekly</changefreq>
    <priority>0.5</priority>
  </url>
  <url>
    <loc>https://example.com/t1729h-solo/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.5</priority>
  </url>
</urlset>
`;
