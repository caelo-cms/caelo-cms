// SPDX-License-Identifier: MPL-2.0

/**
 * #1753, #1761 — a runtime-installed plugin adds JSON-LD nodes and news /
 * video sitemap entries (docs/dev/structured-data.md), end to end on a real
 * Postgres and the real Deno sandbox: staged, approved by an Owner,
 * activated, then asked by the build's plugin services, which the editor
 * preview and the static build both go through.
 *
 * - The nodes come from the `$structuredData` reserved entry, the entries
 *   from `$sitemapEntries`. Pages and media are named by id; core builds
 *   every URL and `@id`.
 * - Adversarial: a free URL to this site and a `javascript:` address, a
 *   `</script>` in a text, an unknown type, a node claiming a core id, an
 *   answer over its page cap, an answer for a page that was not asked about,
 *   a reference image, a sitemap entry with markup or this site's address.
 *   Each is refused, never written, and named as `plugin-value-refused`.
 */

import { afterAll, beforeAll, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  activateApprovedExternalPlugin,
  bootstrap,
  localBuildPluginServices,
  resetPluginHost,
} from "@caelo-cms/plugin-host";
import type { StructuredDataPage } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { buildPageGraph, renderJsonLdScript } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { lockPluginRow } from "../locks.js";
import { registerAdminOps } from "../register.js";
import { rawSystemSql } from "./_raw-system-sql.js";
import { TEST_MEDIA_DIGEST } from "./fixtures/media-digest.js";

let adapter: DatabaseAdapter;
let pluginsRoot = "";
let mediaRoot = "";
const registry = new OperationRegistry();
const system = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "external-structured-data-test",
};
const SLUG = "graph-probe";
const PFX = "t1753sd";
const BASE = "https://blog.example";
const URL_CONTEXT = { siteBaseUrl: BASE, pageUrlStyle: "directory" as const };

/** The fixture's pages and media, by role. */
const page = { article: "", author: "", big: "", stray: "", news: "" };
const asset = { library: "", reference: "" };

const manifest = {
  slug: SLUG,
  version: "1.0.0",
  tier: 2,
  schema: {},
  operations: ["graph", "entries"],
  hasStructuredData: true,
  hasSitemapEntries: true,
  requestedCapabilities: ["structured_data", "sitemap_entries"],
  capabilityReasons: {
    structured_data: "Describe articles and their authors",
    sitemap_entries: "List news articles and videos",
  },
};

/** The plugin's source, with the fixture's page and asset ids written in. */
function source(): string {
  const ids = JSON.stringify({ page, asset, BASE });
  return `const F = ${ids};
export default {slug:"${SLUG}",version:"1.0.0",tier:2,
  structuredDataOperation: "graph",
  sitemapEntriesOperation: "entries",
  operations: {
    graph: async (ctx, args) => {
      const pages = {};
      for (const p of args.pages) {
        if (p.pageId === F.page.big) {
          pages[p.pageId] = { nodes: [{ type: "Thing", id: { fragment: "big" }, properties: { description: "x".repeat(4000), alternateName: "y".repeat(4000), disambiguatingDescription: "z".repeat(4000), slogan: "w".repeat(4000), abstract: "v".repeat(4000) } }] };
          continue;
        }
        if (p.pageId === F.page.stray) {
          pages[F.page.author] = { nodes: [{ type: "Thing", id: { fragment: "shadow" }, properties: {} }] };
          continue;
        }
        if (p.pageId !== F.page.article) continue;
        pages[p.pageId] = {
          webPage: { properties: { reviewedBy: { ref: { page: F.page.author, fragment: "person" } }, url: "https://evil.example/" } },
          nodes: [
            { type: "BlogPosting", id: { fragment: "article" }, properties: {
              headline: p.title,
              author: [{ ref: { page: F.page.author, fragment: "person" } }],
              image: { media: F.asset.library },
              thumbnailUrl: { media: F.asset.reference },
              mainEntityOfPage: { ref: "webpage" },
              datePublished: { live: "published" },
              url: F.BASE + "/somewhere/",
              discussionUrl: { url: F.BASE + "/forum/" },
              sameAs: { url: "javascript:alert(1)" },
              alternativeHeadline: "</script><script>alert(1)</script>",
              about: { node: { type: "Thing", properties: { name: "SEO" } } },
            } },
            { type: "Person", id: { page: F.page.author, fragment: "person" }, properties: { name: "Anna", url: { page: F.page.author } } },
            { type: "Articel", id: { fragment: "typo" }, properties: {} },
            { type: "Organization", id: { fragment: "organization" }, properties: {} },
          ],
        };
      }
      return { pages };
    },
    entries: async (ctx, args) => {
      const pages = {};
      for (const p of args.pages) {
        if (p.pageId === F.page.news) pages[p.pageId] = { news: { title: "Wahl & Folgen" } };
        if (p.pageId === F.page.article) pages[p.pageId] = {
          news: { title: "<b>bold</b>" },
          videos: [
            { title: "Clip", description: "A clip", thumbnail: { media: F.asset.library }, playerUrl: { url: "https://www.youtube.com/embed/x" }, durationSeconds: 60 },
            { title: "Own", description: "On our host", thumbnail: { media: F.asset.library }, contentUrl: { url: F.BASE + "/v.mp4" } },
            { title: "Ref", description: "Reference image", thumbnail: { media: F.asset.reference }, playerUrl: { url: "https://vimeo.com/1" } },
          ],
        };
      }
      return { pages };
    },
  }};`;
}

async function call(
  name: string,
  input: unknown,
  ctx = system as { actorId: string; actorKind: "system" | "human" | "ai"; requestId: string },
) {
  const result = await execute(registry, adapter, ctx, name, input);
  if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
  return result.value;
}

const cleanup = () =>
  rawSystemSql(async (tx) => {
    await tx.unsafe(`DELETE FROM pages WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM templates WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(
      `DELETE FROM media_variants WHERE asset_id IN (SELECT id FROM media_assets WHERE original_name LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM media_assets WHERE original_name LIKE '${PFX}-%'`);
  });

async function owner() {
  const id = crypto.randomUUID();
  await adapter.withAdminTransaction(system, async (tx) => {
    await tx.execute(
      sql`INSERT INTO actors (id,kind,display_name) VALUES (${id}::uuid,'human','owner')`,
    );
    await tx.execute(
      sql`INSERT INTO users (id,email,password_hash) VALUES (${id}::uuid,${`${id}@example.test`},'test-only')`,
    );
    await tx.execute(
      sql`INSERT INTO user_roles (user_id,role_id) SELECT ${id}::uuid,id FROM roles WHERE name='owner'`,
    );
  });
  return { ...system, actorId: id, actorKind: "human" as const };
}

async function install(): Promise<void> {
  const staged = (await call("plugins.stage_installation", { manifest, source: source() })) as {
    installationId: string;
    artifactDigest: string;
  };
  const review = (await call("plugins.list_installations", {})) as {
    installations: { id: string; currentStateDigest: string }[];
  };
  const item = review.installations.find((row) => row.id === staged.installationId);
  if (!item) throw new Error("review missing");
  await call(
    "plugins.approve_installation",
    {
      installationId: staged.installationId,
      artifactDigest: staged.artifactDigest,
      expectedStateDigest: item.currentStateDigest,
      capabilities: manifest.requestedCapabilities,
    },
    await owner(),
  );
  const loaded = await activateApprovedExternalPlugin(staged.installationId);
  if (!loaded.loaded) throw new Error(`activation failed: ${loaded.reason}`);
}

async function media(name: string): Promise<string> {
  const sha256 = createHash("sha256").update(`${PFX}${name}`).digest("hex");
  const storageKey = `${PFX}/${sha256}.webp`;
  const file = join(mediaRoot, storageKey);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `bytes of ${name}`);
  const { assetId } = (await call("media.upload", {
    sha256,
    originalName: `${PFX}-${name}.png`,
    mime: "image/png",
    sizeBytes: 10,
    width: 1200,
    height: 630,
    alt: name,
    storageKey,
    variants: [
      {
        variant: "webp-1200",
        format: "webp",
        width: 1200,
        height: 630,
        sizeBytes: 10,
        storageKey,
        digest: TEST_MEDIA_DIGEST,
      },
    ],
  })) as { assetId: string };
  return assetId;
}

beforeAll(async () => {
  if (!process.env.ADMIN_DATABASE_URL || !process.env.PUBLIC_ADMIN_DATABASE_URL)
    throw new Error("DB URLs required");
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: process.env.ADMIN_DATABASE_URL,
    publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL,
  });
  registerAdminOps(registry);
  await cleanup();
  pluginsRoot = mkdtempSync(join(tmpdir(), "caelo-sd-test-"));
  mediaRoot = mkdtempSync(join(tmpdir(), "caelo-sd-media-"));
  await bootstrap({
    infra: { adapter, registry, lockPluginRow },
    pluginsRoot,
    systemActorId: system.actorId,
  });
  const { templateId } = (await call("templates.create", {
    pageType: "home",
    slug: `${PFX}-tpl`,
    displayName: "T1753SD",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  })) as { templateId: string };
  await call("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  for (const role of Object.keys(page) as (keyof typeof page)[]) {
    page[role] = (
      (await call("pages.create", {
        slug: `${PFX}-${role}`,
        title: role,
        templateId,
        status: "published",
      })) as { pageId: string }
    ).pageId;
  }
  asset.library = await media("library");
  asset.reference = await media("reference");
  await call("media.set_visibility", { assetId: asset.reference, visibility: "reference" });
  await install();
}, 180_000);

afterAll(async () => {
  resetPluginHost();
  await cleanup();
  await adapter.close();
  for (const dir of [pluginsRoot, mediaRoot]) rmSync(dir, { recursive: true, force: true });
});

/** A page record as the build hands it over. */
function record(pageId: string, title: string): StructuredDataPage {
  return {
    pageId,
    pageType: "home",
    path: `/${title}`,
    isHome: false,
    lang: "en",
    title,
    shortTitle: title,
    description: "",
    shareImage: null,
    live: true,
    publishedAt: new Date().toISOString(),
    properties: {},
    terms: [],
    propertyTerms: [],
    listed: [],
  };
}

const input = (ids: string[]) => ({
  pages: ids.map((id) => record(id, Object.entries(page).find(([, v]) => v === id)?.[0] ?? id)),
  related: [],
  pageTypes: { home: { properties: [] } },
  site: { organization: false, name: "Example Blog" },
});

const refused = (point: string, field: string, rule: string) =>
  `plugin-value-refused:${SLUG}.${point}.${field}:${rule}`;

it("checks every node: URLs and ids built by core, what is outside the vocabulary refused", async () => {
  const started = performance.now();
  const collected = await localBuildPluginServices.collectStructuredData(
    input([page.article]),
    URL_CONTEXT,
  );
  const ms = performance.now() - started;
  const parts = collected.parts.get(page.article) ?? [];
  expect(parts).toHaveLength(1);
  const [part] = parts;
  const article = `${BASE}/${PFX}-article/`;
  const author = `${BASE}/${PFX}-author/`;
  expect(part?.webPage).toEqual({ reviewedBy: { "@id": `${author}#person` } });
  expect(part?.nodes.map((n) => n["@id"])).toEqual([`${article}#article`, `${author}#person`]);
  expect(part?.nodes[0]).toEqual({
    "@type": "BlogPosting",
    "@id": `${article}#article`,
    headline: "article",
    author: [{ "@id": `${author}#person` }],
    image: { $caeloMedia: asset.library },
    mainEntityOfPage: { "@id": article },
    datePublished: { $caeloLive: "published" },
    about: { "@type": "Thing", name: "SEO" },
  });
  expect(part?.nodes[1]).toEqual({
    "@type": "Person",
    "@id": `${author}#person`,
    name: "Anna",
    url: author,
  });
  expect([...(collected.refused.get(page.article) ?? [])].sort()).toEqual(
    [
      refused("structured-data", "url", "property-not-allowed"),
      refused("structured-data", "thumbnailUrl", "media-reference"),
      refused("structured-data", "url", "text-url"),
      refused("structured-data", "discussionUrl", "url-own-site"),
      refused("structured-data", "sameAs", "url-scheme"),
      refused("structured-data", "alternativeHeadline", "text-markup"),
      refused("structured-data", "type", "type-unknown"),
      refused("structured-data", "id", "id-reserved"),
    ].sort(),
  );

  // The graph core writes from it: one script, nothing of the refused parts.
  const { graph, refusals } = buildPageGraph(
    {
      siteBaseUrl: BASE,
      canonical: article,
      siteName: "Example Blog",
      siteLanguage: "en",
      pageLanguage: "en",
      pageTitle: "article",
      description: "",
      imageUrl: null,
      organization: {},
      breadcrumbs: [],
      liveDates: { published: "2026-11-01T09:00:00.000Z", modified: "2026-11-02T09:00:00.000Z" },
    },
    parts,
    (id) => (id === asset.library ? `${BASE}/_assets/library.jpg` : null),
  );
  expect(refusals).toEqual([]);
  const script = renderJsonLdScript(graph);
  for (const banned of ["evil.example", "javascript:", "<script>alert", "Articel", "/somewhere/"]) {
    expect(script).not.toContain(banned);
  }
  expect(script).toContain('"reviewedBy":{"@id":"https://blog.example/t1753sd-author/#person"}');
  console.log(`[measure] structured data from an installed plugin, one page: ${ms.toFixed(0)} ms`);
}, 120_000);

it("an answer over its page cap gives the page nothing; an answer for a page not asked is refused", async () => {
  const big = await localBuildPluginServices.collectStructuredData(input([page.big]), URL_CONTEXT);
  expect(big.parts.get(page.big)).toBeUndefined();
  expect(big.refused.get(page.big)).toEqual([refused("structured-data", "page", "page-too-large")]);
  const stray = await localBuildPluginServices.collectStructuredData(
    input([page.stray]),
    URL_CONTEXT,
  );
  expect(stray.parts.size).toBe(0);
  expect(stray.refused.get(page.stray)).toEqual([
    refused("structured-data", "answer", "page-not-asked"),
  ]);
}, 120_000);

it("checks every sitemap entry: no markup, no address of this site, library thumbnails only", async () => {
  const collected = await localBuildPluginServices.collectSitemapEntries(
    input([page.news, page.article]),
    URL_CONTEXT,
  );
  expect(collected.news.get(page.news)).toEqual({ title: "Wahl & Folgen" });
  expect(collected.news.has(page.article)).toBe(false);
  expect(collected.videos.get(page.article)).toEqual([
    {
      title: "Clip",
      description: "A clip",
      thumbnail: asset.library,
      playerUrl: "https://www.youtube.com/embed/x",
      durationSeconds: 60,
    },
  ]);
  expect([...(collected.refused.get(page.article) ?? [])].sort()).toEqual(
    [
      refused("sitemap-entries", "news", "text-markup"),
      refused("sitemap-entries", "contentUrl", "url-own-site"),
      refused("sitemap-entries", "thumbnail", "media-reference"),
    ].sort(),
  );
}, 120_000);

it("asks a sandboxed plugin about pages too large for one message in several calls (Codex on #1797)", async () => {
  // 45 pages with two 20,000-character properties: about 1.8 MB, more than
  // one sandbox message, which failed the whole call before.
  const long = "x".repeat(20_000);
  const filler = Array.from({ length: 45 }, (_, i) => ({
    ...record(`f0000000-0000-4000-8000-${String(i).padStart(12, "0")}`, `filler-${i}`),
    properties: { body: long, summary: long },
  }));
  const real = input([page.article, page.news]);
  const big = { ...real, pages: [...filler, ...real.pages] };
  const graph = await localBuildPluginServices.collectStructuredData(big, URL_CONTEXT);
  expect(graph.parts.get(page.article)?.length ?? 0).toBeGreaterThan(0);
  const entries = await localBuildPluginServices.collectSitemapEntries(big, URL_CONTEXT);
  expect(entries.news.get(page.news)).toEqual({ title: "Wahl & Folgen" });
  // A page whose record alone exceeds a message is refused by name, never left out unsaid.
  const huge = { ...record(page.article, "article"), properties: { body: "y".repeat(1_100_000) } };
  const one = await localBuildPluginServices.collectStructuredData(
    { ...input([]), pages: [huge] },
    URL_CONTEXT,
  );
  expect(one.refused.get(page.article)).toEqual([
    refused("structured-data", "page", "record-too-large"),
  ]);
}, 180_000);
