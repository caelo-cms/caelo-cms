// SPDX-License-Identifier: MPL-2.0

/**
 * #1759, #1761 — the shipped `seo` plugin's topic tools and its news and
 * video sitemaps against a real Postgres:
 *
 * - the page index the page-output observer keeps (fed here with the facts
 *   a Stage delivers) makes `list_topic_terms` suggest a topic page for a
 *   term on 5 published articles, and name a near-duplicate term with the
 *   term to keep;
 * - `merge_terms` re-tags the pages and redirects the merged term's topic
 *   page in one call (core's `lists.merge_terms`);
 * - `suggest_internal_links` names its reasons; the write hint names the
 *   topic page a write mentions;
 * - a build writes `sitemap-news.xml` with the recent indexable news
 *   articles only and `sitemap-video.xml` with the video page, and
 *   robots.txt lists both.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  bootstrap,
  localBuildPluginServices,
  resetPluginHost,
  runPluginOperation,
  syncPluginHost,
} from "@caelo-cms/plugin-host";
import type { PageOutputFacts } from "@caelo-cms/plugin-sdk";
import seoPlugin from "@caelo-cms/plugin-seo";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext, ListItem } from "@caelo-cms/shared";
import { buildRobotsTxtWithSitemap } from "@caelo-cms/static-generator";
import { SQL } from "bun";
import { lockPluginRow } from "../locks.js";
import { registerAdminOps } from "../register.js";
import { TEST_MEDIA_DIGEST } from "./fixtures/media-digest.js";
import { runSeoPass } from "./fixtures/seo-pass.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "system", requestId: "t1759" };
const PFX = "t1759";
const BASE = "https://news.example";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let buildDir = "";
const restore: (() => Promise<void>)[] = [];
let siteNameBefore: string | null = null;
const articles: string[] = [];
const ids = {
  home: "",
  topic: "",
  dupTopic: "",
  fresh: "",
  first: "",
  hidden: "",
  old: "",
  video: "",
};
let vocab = { id: "", slug: `${PFX}-tags`, seo: "", seoTool: "", seoTools: "" };

async function sqlSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

async function run<T>(name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function seo<T>(
  operation: string,
  args: unknown,
  origin: "owner-panel" | "observer" = "owner-panel",
): Promise<T> {
  const r = await runPluginOperation({
    pluginSlug: "seo",
    operationName: operation,
    args,
    invocation:
      origin === "observer"
        ? { origin, actorId: SYSTEM_ID, stageRunId: crypto.randomUUID() }
        : { origin, actorId: SYSTEM_ID },
  });
  if (!r.ok) throw new Error(`${operation}: ${r.error.kind}: ${r.error.message}`);
  return r.value as T;
}

const TEMPLATE_HTML = `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`;

async function pageType(slug: string, properties: unknown[], vocabularies: unknown[] = []) {
  const { templateId } = await run<{ templateId: string }>("templates.create", {
    newPageType: {
      slug: `${PFX}-${slug}`,
      name: slug,
      purpose: `${slug} pages of the test site`,
      collection: true,
      properties,
      vocabularies,
    },
    slug: `${PFX}-${slug}-tpl`,
    displayName: `${PFX} ${slug}`,
    html: TEMPLATE_HTML,
  });
  await run("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
}

async function page(
  slug: string,
  type: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  return (
    await run<{ pageId: string }>("pages.create", {
      slug: `${PFX}-${slug}`,
      title: slug,
      pageType: `${PFX}-${type}`,
      status: "published",
      ...extra,
    })
  ).pageId;
}

/** The facts a Stage would deliver of a published page. */
function facts(
  pageId: string,
  path: string,
  terms: string[],
  links: string[] = [],
): PageOutputFacts {
  return {
    pageId,
    url: `${BASE}${path}/`,
    path,
    lang: "en",
    title: path.slice(1),
    shortTitle: null,
    metaDescription: null,
    pageType: `${PFX}-article`,
    properties: {},
    terms: { [vocab.slug]: terms },
    breadcrumb: [],
    noindex: false,
    notFoundPage: false,
    hasDeferredContent: false,
    truncated: false,
    modules: [],
    texts: [],
    links: links.map((target) => ({
      href: `/${target}`,
      path: `/${target}`,
      targetPageId: target,
      text: "x",
      moduleId: null,
      contentInstanceId: null,
      zone: "page",
      pluginSlug: null,
    })),
    outputHash: pageId,
  };
}

async function media(name: string, mediaRoot: string): Promise<string> {
  const sha256 = createHash("sha256").update(`${PFX}${name}`).digest("hex");
  const storageKey = `${PFX}/${sha256}.webp`;
  const file = join(mediaRoot, storageKey);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `bytes of ${name}`);
  const { assetId } = await run<{ assetId: string }>("media.upload", {
    sha256,
    originalName: `${PFX}-${name}.png`,
    mime: "image/png",
    sizeBytes: 10,
    width: 1280,
    height: 720,
    alt: name,
    storageKey,
    variants: [
      {
        variant: "webp-1200",
        format: "webp",
        width: 1200,
        height: 675,
        sizeBytes: 10,
        storageKey,
        digest: TEST_MEDIA_DIGEST,
      },
    ],
  });
  return assetId;
}

async function cleanup(): Promise<void> {
  await sqlSystem(async (tx) => {
    await tx.unsafe(`UPDATE pages SET deleted_at = now() WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(`UPDATE page_types SET deleted_at = now() WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(`UPDATE templates SET deleted_at = now() WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(`DELETE FROM pending_redirects WHERE from_path LIKE '%${PFX}-%'`);
    await tx.unsafe(
      `UPDATE pages_seo SET og_image_asset_id = NULL WHERE og_image_asset_id IN (SELECT id FROM media_assets WHERE original_name LIKE '${PFX}-%')`,
    );
    await tx.unsafe(
      `DELETE FROM media_variants WHERE asset_id IN (SELECT id FROM media_assets WHERE original_name LIKE '${PFX}-%')`,
    );
    await tx.unsafe(`DELETE FROM media_assets WHERE original_name LIKE '${PFX}-%'`);
    await tx.unsafe(
      "DO $$ BEGIN IF to_regclass('plugin_seo.page_index') IS NOT NULL THEN DELETE FROM plugin_seo.page_index; DELETE FROM plugin_seo.type_mappings; END IF; END $$",
    );
  });
}

beforeAll(async () => {
  resetPluginHost();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  buildDir = mkdtempSync(join(tmpdir(), "t1759-build-"));
  restore.push(await pinSiteBaseUrl(ADMIN_URL, BASE));
  restore.push(await pinSiteLanguage(ADMIN_URL, "en"));
  siteNameBefore = await sqlSystem(async (tx) => {
    const rows = await tx`SELECT site_name FROM site_defaults WHERE id = 1`;
    await tx`UPDATE site_defaults SET site_name = 'Example News' WHERE id = 1`;
    return (rows[0] as { site_name: string | null } | undefined)?.site_name ?? null;
  });

  await run("lists.upsert_many", {
    lists: [
      {
        slug: vocab.slug,
        name: "Topics",
        purpose: "Topics articles are filed under",
        type: "tags",
        items: [
          { node: "tag", values: { name: "SEO", slug: "seo" } },
          { node: "tag", values: { name: "SEO-Tool", slug: "seo-tool" } },
          { node: "tag", values: { name: "SEO Tools", slug: "seo-tools" } },
        ],
      },
    ],
  });
  const list = (
    await run<{ list: { id: string; items: ListItem[] } }>("lists.get", { slug: vocab.slug })
  ).list;
  vocab = {
    ...vocab,
    id: list.id,
    seo: list.items[0]?.id ?? "",
    seoTool: list.items[1]?.id ?? "",
    seoTools: list.items[2]?.id ?? "",
  };
  const term = (item: string) => `caelo:term/${list.id}/${item}`;
  await pageType("article", [], [{ list: list.id, cardinality: "many" }]);
  await pageType("topic", []);
  await pageType("news", []);
  await pageType("video", [
    { name: "length", label: "Length", type: "text" },
    { name: "player", label: "Player", type: "link" },
  ]);

  ids.home = await page("home", "topic");
  ids.topic = await page("topic-tools", "topic");
  ids.dupTopic = await page("topic-tool", "topic");
  for (let i = 0; i < 5; i++) {
    articles.push(await page(`a${i}`, "article", { terms: [term(vocab.seo)] }));
  }
  articles.push(await page("a5", "article", { terms: [term(vocab.seoTool)] }));
  articles.push(await page("a6", "article", { terms: [term(vocab.seoTools)] }));
  await run("lists.patch_items_many", {
    lists: [
      {
        slug: vocab.slug,
        patches: [
          {
            op: "update",
            itemId: vocab.seoTools,
            values: { landing_page: { href: `caelo:page/${ids.topic}` } },
          },
          {
            op: "update",
            itemId: vocab.seoTool,
            values: { landing_page: { href: `caelo:page/${ids.dupTopic}` } },
          },
        ],
      },
    ],
  });

  ids.fresh = await page("fresh", "news");
  // Goes live first with the build under test: no first_published_at yet.
  ids.first = await page("first", "news");
  ids.hidden = await page("hidden", "news");
  ids.old = await page("old", "news");
  await run("pages_seo.set", { pageId: ids.hidden, noindex: true });
  await sqlSystem(async (tx) => {
    await tx`UPDATE pages SET first_published_at = now() - interval '1 hour' WHERE id IN (${ids.fresh}::uuid, ${ids.hidden}::uuid)`;
    await tx`UPDATE pages SET first_published_at = now() - interval '5 days' WHERE id = ${ids.old}::uuid`;
  });
  ids.video = await page("video", "video", {
    properties: { length: "PT4M13S", player: { href: "https://www.youtube.com/embed/abc123" } },
  });
  const thumb = await media("thumb", buildDir);
  await run("pages_seo.set", {
    pageId: ids.video,
    ogImageAssetId: thumb,
    metaDescription: "How the plugin writes one graph per page, in four minutes.",
  });

  const report = await bootstrap({
    infra: { adapter, registry, lockPluginRow },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ID,
    testPlugins: [{ definition: seoPlugin }],
  });
  expect(report.failed).toEqual([]);
  await syncPluginHost(true);
  await seo("set_schema_mappings_many", {
    mappings: [
      { pageType: `${PFX}-news`, schemaType: "NewsArticle" },
      {
        pageType: `${PFX}-video`,
        schemaType: "VideoObject",
        roles: { duration: "prop:length", embed_url: "prop:player" },
      },
    ],
  });
  // What a Stage's page output delivers to the observer: the published articles.
  await seo(
    "observe_pages",
    {
      runId: "t1759",
      pages: [
        facts(ids.home, `/${PFX}-home`, [], [articles[0] as string]),
        ...articles
          .slice(0, 5)
          .map((id, i) =>
            facts(id, `/${PFX}-a${i}`, [vocab.seo], i === 0 ? [articles[1] as string] : []),
          ),
        facts(articles[5] as string, `/${PFX}-a5`, [vocab.seoTool]),
        facts(articles[6] as string, `/${PFX}-a6`, [vocab.seoTools]),
      ],
      removed: [],
      placementChanges: [],
      final: true,
      publishedPageCount: 8,
    },
    "observer",
  );
  await sqlSystem(async (tx) => {
    await tx`UPDATE site_defaults SET home_page_id = ${ids.home}::uuid WHERE id = 1`;
  });
}, 180_000);

afterAll(async () => {
  try {
    resetPluginHost();
    await sqlSystem(async (tx) => {
      await tx`UPDATE site_defaults SET site_name = ${siteNameBefore}, home_page_id = NULL WHERE id = 1`;
    });
    await cleanup();
  } finally {
    for (const r of restore) await r();
    rmSync(buildDir, { recursive: true, force: true });
    await adapter.close();
  }
}, 60_000);

interface TermsAnswer {
  threshold: number;
  vocabularies: {
    slug: string;
    terms: {
      itemId: string;
      name: string;
      pages: number;
      topicPage: string | null;
      suggestTopicPage: boolean;
    }[];
    nearDuplicates: {
      terms: { itemId: string; name: string }[];
      mergeInto: string;
      reason: string;
    }[];
  }[];
}

describe("#1759 topic pages and internal links", () => {
  it("suggests a topic page for a term on 5 published articles, and names a duplicate term", async () => {
    const r = await seo<TermsAnswer>("list_topic_terms", { vocabulary: vocab.slug });
    expect(r.threshold).toBe(5);
    const [v] = r.vocabularies;
    expect(v?.terms.map((t) => [t.name, t.pages, t.suggestTopicPage])).toEqual([
      ["SEO", 5, true],
      ["SEO Tools", 1, false],
      ["SEO-Tool", 1, false],
    ]);
    expect(v?.nearDuplicates).toEqual([
      {
        terms: [
          { itemId: vocab.seoTools, name: "SEO Tools", pages: 1 },
          { itemId: vocab.seoTool, name: "SEO-Tool", pages: 1 },
        ],
        mergeInto: vocab.seoTools,
        reason: "the same name apart from case, accents, hyphens or a plural",
      },
    ]);
  });

  it("names the reasons of its link suggestions, and the page's inbound links and click depth", async () => {
    const r = await seo<{
      page: { inbound: number; clickDepth: number | null };
      suggestions: { pageId: string; reasons: string[] }[];
    }>("suggest_internal_links", { page: `/${PFX}-a0` });
    expect(r.page).toMatchObject({ path: `/${PFX}-a0`, inbound: 1, clickDepth: 1 });
    expect(r.suggestions.map((s) => s.pageId)).not.toContain(articles[1]);
    expect(r.suggestions[0]?.reasons).toEqual([
      "shares the terms SEO",
      "same page type (t1759-article)",
      "no page links to it yet",
    ]);
  });

  it("hints at the topic page a write mentions, unless the write links it", async () => {
    const hints = await seo<{ hints: string[] }>("write_hints", {
      writes: [
        { kind: "values", moduleId: null, values: { body: "<p>Our guide to SEO Tools.</p>" } },
      ],
    });
    expect(hints.hints).toEqual([
      `The text mentions "SEO Tools"; its topic page /${PFX}-topic-tools covers it — link it where the text names it (suggest_internal_links lists more pages to link).`,
    ]);
    const linked = await seo<{ hints: string[] }>("write_hints", {
      writes: [
        {
          kind: "values",
          moduleId: null,
          values: { body: `<p>Our guide to <a href="caelo:page/${ids.topic}">SEO Tools</a>.</p>` },
        },
      ],
    });
    expect(linked.hints).toEqual([]);
  });

  it("merges a duplicate term in one call: pages re-tagged, its topic page redirected", async () => {
    const r = await seo<{ retaggedPages: number; redirectedOverviewPages: { to: string }[] }>(
      "merge_terms",
      { vocabulary: vocab.slug, merges: [{ from: ["SEO-Tool"], into: "SEO Tools" }] },
    );
    expect(r.retaggedPages).toBe(1);
    expect(r.redirectedOverviewPages.map((x) => x.to)).toEqual([`/${PFX}-topic-tools`]);
    const { pages } = await run<{ pages: { id: string; terms: string[] }[] }>("pages.list", {
      includeDeleted: false,
      pageIds: [articles[5] as string],
    });
    expect(pages[0]?.terms).toEqual([`caelo:term/${vocab.id}/${vocab.seoTools}`]);
  });
});

describe("#1761 news and video sitemaps", () => {
  it("lists recent indexable news and the video page, and robots.txt names both", async () => {
    const built = [ids.fresh, ids.first, ids.hidden, ids.old, ids.video].map((pageId) => ({
      pageId,
      pageSlug: pageId,
      html: "<html><head><title>x</title></head><body>b</body></html>",
    }));
    const r = await adapter.withAdminTransaction(SYS, (tx) =>
      runSeoPass({
        tx,
        plugins: localBuildPluginServices,
        buildDir,
        mediaRoot: buildDir,
        pages: built,
        settings: {
          siteBaseUrl: BASE,
          sitemapEnabled: true,
          siteLanguage: "en",
          siteName: "Example News",
          organization: {},
        },
        pageUrlStyle: "directory",
        notFoundPageId: null,
        unresolved: "report",
      }),
    );
    expect(r.renderFailures).toEqual([]);
    expect(r.extraSitemaps).toEqual(["sitemap-news.xml", "sitemap-video.xml"]);
    const news = readFileSync(join(buildDir, "sitemap-news.xml"), "utf8");
    expect(news).toContain(`<loc>${BASE}/${PFX}-fresh/</loc>`);
    // The build that first publishes an article lists it (Codex review on #1797).
    expect(news).toContain(`<loc>${BASE}/${PFX}-first/</loc>`);
    expect(news).toContain("<news:name>Example News</news:name>");
    expect(news).not.toContain(`${PFX}-hidden`);
    expect(news).not.toContain(`${PFX}-old`);
    const video = readFileSync(join(buildDir, "sitemap-video.xml"), "utf8");
    expect(video).toContain(`<loc>${BASE}/${PFX}-video/</loc>`);
    expect(video).toContain(
      "<video:player_loc>https://www.youtube.com/embed/abc123</video:player_loc>",
    );
    expect(video).toContain("<video:duration>253</video:duration>");
    expect(video).toMatch(
      /<video:thumbnail_loc>https:\/\/news\.example\/_assets\/[^<]+<\/video:thumbnail_loc>/,
    );
    // The VideoObject in the page's graph names the same thumbnail.
    const graph = JSON.parse(
      /<script type="application\/ld\+json">(.*?)<\/script>/.exec(built[4]?.html as string)?.[1] ??
        "{}",
    ) as { "@graph": Record<string, unknown>[] };
    const videoNode = graph["@graph"].find((n) => n["@type"] === "VideoObject");
    expect(videoNode?.duration).toBe("PT4M13S");
    expect(videoNode?.embedUrl).toBe("https://www.youtube.com/embed/abc123");
    expect(String(videoNode?.uploadDate)).toMatch(/^\d{4}-/);

    const robots = buildRobotsTxtWithSitemap(
      "index",
      BASE,
      { sitemap: true, feed: false, extraSitemaps: r.extraSitemaps },
      [],
    );
    expect(robots.split("\n").filter((l) => l.startsWith("Sitemap:"))).toEqual([
      `Sitemap: ${BASE}/sitemap.xml`,
      `Sitemap: ${BASE}/sitemap-news.xml`,
      `Sitemap: ${BASE}/sitemap-video.xml`,
    ]);
    expect(
      buildRobotsTxtWithSitemap(
        "noindex",
        BASE,
        { sitemap: true, feed: false, extraSitemaps: r.extraSitemaps },
        [],
      ),
    ).toBe("User-agent: *\nDisallow: /\n");
  }, 120_000);
});
