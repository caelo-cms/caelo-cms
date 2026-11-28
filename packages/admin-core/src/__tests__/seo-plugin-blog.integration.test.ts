// SPDX-License-Identifier: MPL-2.0

/**
 * #1756, #1753, #1759 — the shipped `seo` plugin on a fixture blog, end to
 * end on a real Postgres through the editor preview and the build's SEO
 * pass:
 *
 * - an article renders BlogPosting with its two authors as ordered Person
 *   `@id`s, each Person in the graph; the author pages render ProfilePage +
 *   Person, and an author page lists the articles naming it;
 * - a reviewed article renders `reviewedBy` and `lastReviewed`, and the
 *   review date is visible on the page;
 * - a topic page renders CollectionPage + ItemList of the articles it shows;
 * - preview and build write the same graph (apart from the live dates only
 *   a build has), every `@id` reference resolves (the Stage's
 *   structured-data check has no finding);
 * - a mapping set in a chat is a draft: the chat's preview shows it, main
 *   does not until the Stage.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrap,
  localBuildPluginServices,
  resetPluginHost,
  runPluginOperation,
  syncPluginHost,
} from "@caelo-cms/plugin-host";
import seoPlugin from "@caelo-cms/plugin-seo";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { lockPluginRow } from "../locks.js";
import { createStructuredDataCheck } from "../quality/checks/structured-data.js";
import { registerAdminOps } from "../register.js";
import { runSeoPass } from "./fixtures/seo-pass.js";
import { wipeSeoPluginRows } from "./fixtures/seo-plugin-rows.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "system", requestId: "t1756" };
const PFX = "t1756";
const BASE = "https://blog.example";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let buildDir = "";
const restore: (() => Promise<void>)[] = [];
let previous: { site_name: string | null; organization_json: unknown } | null = null;
const ids = { anna: "", ben: "", cleo: "", article: "", topic: "" };
let tags = { id: "", seo: "" };

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

async function run<T>(name: string, input: unknown, ctx: ExecutionContext = SYS): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function seo<T>(
  operation: string,
  args: unknown,
  invocation: Parameters<typeof runPluginOperation>[0]["invocation"] = {
    origin: "owner-panel",
    actorId: SYSTEM_ID,
  },
): Promise<T> {
  const r = await runPluginOperation({
    pluginSlug: "seo",
    operationName: operation,
    args,
    invocation,
  });
  if (!r.ok) throw new Error(`${operation}: ${r.error.kind}: ${r.error.message}`);
  return r.value as T;
}

/** The nodes of the page's one JSON-LD graph. */
function graphOf(html: string): Record<string, unknown>[] {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)];
  expect(blocks).toHaveLength(1);
  return (JSON.parse(blocks[0]?.[1] as string) as { "@graph": Record<string, unknown>[] })[
    "@graph"
  ];
}

const node = (graph: Record<string, unknown>[], id: string) => graph.find((n) => n["@id"] === id);
const url = (slug: string) => `${BASE}/${PFX}-${slug}/`;

/** An Owner the chat acts for (the mapping tool needs content.write). */
async function owner(): Promise<string> {
  const id = crypto.randomUUID();
  await sqlSystem(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${id}::uuid, 'human', 'owner')`;
    await tx`INSERT INTO users (id, email, password_hash) VALUES (${id}::uuid, ${`${id}@example.test`}, 'test-only')`;
    await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${id}::uuid, id FROM roles WHERE name = 'owner'`;
  });
  return id;
}

async function preview(pageId: string, chatBranchId?: string): Promise<string> {
  return (
    await run<{ html: string; missingSlots: string[] }>("pages.render_preview", {
      pageId,
      ...(chatBranchId ? { chatBranchId } : {}),
    })
  ).html;
}

const TEMPLATE_HTML = `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`;

async function templateFor(slug: string, newPageType: Record<string, unknown>): Promise<string> {
  const { templateId } = await run<{ templateId: string }>("templates.create", {
    newPageType,
    slug: `${PFX}-${slug}-tpl`,
    displayName: `${PFX} ${slug}`,
    html: TEMPLATE_HTML,
  });
  await run("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  return templateId;
}

async function page(
  slug: string,
  title: string,
  pageType: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const { pageId } = await run<{ pageId: string }>("pages.create", {
    slug: `${PFX}-${slug}`,
    title,
    pageType: `${PFX}-${pageType}`,
    status: "published",
    ...extra,
  });
  return pageId;
}

async function cleanup(): Promise<void> {
  await sqlSystem(async (tx) => {
    await tx.unsafe(`UPDATE pages SET deleted_at = now() WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(`UPDATE page_types SET deleted_at = now() WHERE slug LIKE '${PFX}-%'`);
    await tx.unsafe(`UPDATE templates SET deleted_at = now() WHERE slug LIKE '${PFX}-%'`);
  });
}

beforeAll(async () => {
  resetPluginHost();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  buildDir = mkdtempSync(join(tmpdir(), "t1756-build-"));
  restore.push(await pinSiteBaseUrl(ADMIN_URL, BASE));
  restore.push(await pinSiteLanguage(ADMIN_URL, "en"));
  previous = await sqlSystem(async (tx) => {
    const rows = await tx`SELECT site_name, organization_json FROM site_defaults WHERE id = 1`;
    await tx`UPDATE site_defaults SET site_name = 'Example Blog', organization_json = ${JSON.stringify({ name: "Example GmbH", url: `${BASE}/` })}::text::jsonb WHERE id = 1`;
    return (rows[0] as { site_name: string | null; organization_json: unknown }) ?? null;
  });

  const tagList = `${PFX}-tags`;
  await run("lists.upsert_many", {
    lists: [
      {
        slug: tagList,
        name: "Blog topics",
        purpose: "Topics articles are filed under",
        type: "tags",
        items: [{ node: "tag", values: { name: "SEO", slug: "seo" } }],
      },
      {
        // What an author knows about: a term property, not how the page is filed.
        slug: `${PFX}-skills`,
        name: "Skills",
        purpose: "Subjects an author knows about",
        type: "tags",
        items: [{ node: "tag", values: { name: "Crawling", slug: "crawling" } }],
      },
    ],
  });
  const list = (
    await run<{ list: { id: string; items: { id: string }[] } }>("lists.get", { slug: tagList })
  ).list;
  tags = { id: list.id, seo: list.items[0]?.id ?? "" };
  const skills = (
    await run<{ list: { id: string; items: { id: string }[] } }>("lists.get", {
      slug: `${PFX}-skills`,
    })
  ).list;
  const crawling = `caelo:term/${skills.id}/${skills.items[0]?.id ?? ""}`;

  await templateFor("author", {
    slug: `${PFX}-author`,
    name: "Author",
    purpose: "A page about one author of the blog",
    collection: true,
    properties: [
      { name: "role", label: "Role", type: "text" },
      { name: "bio", label: "Bio", type: "richtext" },
      { name: "linkedin", label: "LinkedIn", type: "link" },
      {
        name: "expertise",
        label: "Expertise",
        type: "term",
        list: `${PFX}-skills`,
        multiple: true,
      },
    ],
    vocabularies: [],
  });
  await templateFor("article", {
    slug: `${PFX}-article`,
    name: "Article",
    purpose: "A blog post",
    collection: true,
    properties: [
      {
        name: "authors",
        label: "Authors",
        type: "page",
        pageType: `${PFX}-author`,
        multiple: true,
      },
      { name: "reviewed_by", label: "Reviewed by", type: "page", pageType: `${PFX}-author` },
      { name: "last_reviewed", label: "Last reviewed", type: "date" },
    ],
    vocabularies: [{ list: tags.id, cardinality: "many" }],
  });
  await templateFor("topic", {
    slug: `${PFX}-topic`,
    name: "Topic",
    purpose: "A curated topic page",
    collection: false,
    properties: [],
    vocabularies: [],
  });

  ids.anna = await page("anna", "Anna Berg", "author", {
    shortTitle: "Anna Berg",
    properties: {
      role: "Head of SEO",
      bio: "<p>Anna has worked on <strong>search</strong> since 2010.</p>",
      linkedin: { href: "https://www.linkedin.com/in/anna-berg" },
      expertise: [crawling],
    },
  });
  ids.ben = await page("ben", "Ben Okafor", "author", { properties: { role: "Editor" } });
  ids.cleo = await page("cleo", "Cleo Park", "author", { properties: { role: "Reviewer" } });
  ids.article = await page("graph", "One graph per page", "article", {
    properties: {
      authors: [ids.ben, ids.anna],
      reviewed_by: [ids.cleo],
      last_reviewed: "2026-11-20",
    },
    terms: [`caelo:term/${tags.id}/${tags.seo}`],
  });
  ids.topic = await page("seo", "SEO", "topic");
  await run("lists.patch_items_many", {
    lists: [
      {
        slug: tagList,
        patches: [
          {
            op: "update",
            itemId: tags.seo,
            values: { landing_page: { href: `caelo:page/${ids.topic}` } },
          },
        ],
      },
    ],
  });

  await run("pages.build_page", {
    page: { pageId: ids.article },
    modules: [
      {
        blockName: "content",
        displayName: `${PFX} byline`,
        description: "Who wrote the article and who reviewed it, and when.",
        kind: "content",
        html: '<p class="byline">{{#page.props.authors}}<a href="{{link}}">{{title}}</a>{{/page.props.authors}}</p><p class="review">{{review_label}} {{#page.props.reviewed_by}}{{title}}{{/page.props.reviewed_by}} on <time>{{page.props.last_reviewed}}</time></p>',
        fields: [
          { name: "review_label", kind: "text", label: "Review label", default: "Reviewed by" },
        ],
        content: { source: "inline", values: { review_label: "Reviewed by" } },
      },
    ],
  });
  await run("pages.build_page", {
    page: { pageId: ids.anna },
    modules: [
      {
        blockName: "content",
        displayName: `${PFX} author box`,
        description: "The author's role and bio, and every article they wrote.",
        kind: "content",
        html: '<h1>{{page.title}}</h1><p>{{page.props.role}}</p><ul class="articles">{{#articles}}<li><a href="{{link}}">{{title}}</a></li>{{/articles}}</ul>',
        fields: [
          {
            name: "articles",
            kind: "list",
            label: "Articles",
            listType: "links",
            bind: "source",
            source: {
              kind: "query",
              editable: [],
              defaults: {
                page_type: `${PFX}-article`,
                refers_to: { property: "authors", page: "self" },
                order: "published_desc",
              },
            },
            paginate: {},
          },
        ],
        content: { source: "inline", values: {} },
      },
    ],
  });
  await run("pages.build_page", {
    page: { pageId: ids.topic },
    modules: [
      {
        blockName: "content",
        displayName: `${PFX} topic list`,
        description: "Every article filed under the topic.",
        kind: "content",
        html: '<ul class="topic">{{#articles}}<li><a href="{{link}}">{{title}}</a></li>{{/articles}}</ul>',
        fields: [
          {
            name: "articles",
            kind: "list",
            label: "Articles",
            listType: "links",
            bind: "source",
            source: {
              kind: "query",
              editable: [],
              defaults: {
                page_type: `${PFX}-article`,
                terms: [`caelo:term/${tags.id}/${tags.seo}`],
                order: "published_desc",
              },
            },
            paginate: {},
          },
        ],
        content: { source: "inline", values: {} },
      },
    ],
  });

  const report = await bootstrap({
    infra: { adapter, registry, lockPluginRow },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ID,
    testPlugins: [{ definition: seoPlugin }],
  });
  expect(report.failed).toEqual([]);
  await syncPluginHost(true);
  await wipeSeoPluginRows(ADMIN_URL);
  await seo("set_schema_mappings_many", {
    mappings: [
      {
        pageType: `${PFX}-article`,
        schemaType: "BlogPosting",
        roles: {
          authors: "prop:authors",
          reviewer: "prop:reviewed_by",
          reviewed_on: "prop:last_reviewed",
        },
      },
      {
        pageType: `${PFX}-author`,
        schemaType: "ProfilePage",
        roles: {
          job_title: "prop:role",
          bio: "prop:bio",
          same_as: ["prop:linkedin"],
          works_for: "organization",
          knows_about: "prop:expertise",
        },
      },
      { pageType: `${PFX}-topic`, schemaType: "CollectionPage" },
    ],
  });
}, 180_000);

afterAll(async () => {
  try {
    await sqlSystem(async (tx) => {
      await tx.unsafe(`DELETE FROM chat_sessions WHERE title LIKE '${PFX}-%'`);
    }).catch(() => undefined);
    await wipeSeoPluginRows(ADMIN_URL as string);
    resetPluginHost();
    await sqlSystem(async (tx) => {
      if (previous) {
        await tx`UPDATE site_defaults SET site_name = ${previous.site_name}, organization_json = ${JSON.stringify(previous.organization_json ?? {})}::text::jsonb WHERE id = 1`;
      }
    });
    await cleanup();
  } finally {
    for (const r of restore) await r();
    rmSync(buildDir, { recursive: true, force: true });
    await adapter.close();
  }
}, 60_000);

describe("#1756 the seo plugin on a blog", () => {
  it("an article is a BlogPosting with its two authors in order, each a Person of the graph", async () => {
    const html = await preview(ids.article);
    const graph = graphOf(html);
    const article = node(graph, `${url("graph")}#article`);
    expect(article?.["@type"]).toBe("BlogPosting");
    expect(article?.author).toEqual([
      { "@id": `${url("ben")}#person` },
      { "@id": `${url("anna")}#person` },
    ]);
    expect(article?.publisher).toEqual({ "@id": `${BASE}/#organization` });
    expect(article?.mainEntityOfPage).toEqual({ "@id": url("graph") });
    expect(node(graph, `${url("anna")}#person`)).toEqual({
      "@type": "Person",
      "@id": `${url("anna")}#person`,
      name: "Anna Berg",
      url: url("anna"),
      jobTitle: "Head of SEO",
    });
    expect(node(graph, `${url("ben")}#person`)?.name).toBe("Ben Okafor");
  });

  it("a reviewed article carries reviewedBy and lastReviewed, and the page shows the date", async () => {
    const html = await preview(ids.article);
    const webPage = node(graphOf(html), url("graph"));
    expect(webPage?.reviewedBy).toEqual({ "@id": `${url("cleo")}#person` });
    expect(webPage?.lastReviewed).toBe("2026-11-20");
    expect(node(graphOf(html), `${url("cleo")}#person`)?.name).toBe("Cleo Park");
    expect(html).toContain("Reviewed by Cleo Park on <time>2026-11-20</time>");
  });

  it("an author page is a ProfilePage of its Person and lists the articles naming it", async () => {
    const html = await preview(ids.anna);
    const graph = graphOf(html);
    const webPage = node(graph, url("anna"));
    expect(webPage?.["@type"]).toBe("ProfilePage");
    expect(webPage?.mainEntity).toEqual({ "@id": `${url("anna")}#person` });
    expect(node(graph, `${url("anna")}#person`)).toEqual({
      "@type": "Person",
      "@id": `${url("anna")}#person`,
      name: "Anna Berg",
      url: url("anna"),
      jobTitle: "Head of SEO",
      description: "Anna has worked on search since 2010.",
      sameAs: "https://www.linkedin.com/in/anna-berg",
      worksFor: { "@id": `${BASE}/#organization` },
      // From the expertise property's term; the page is not tagged with it.
      knowsAbout: "Crawling",
    });
    expect(html).toContain(`<a href="/${PFX}-graph/">One graph per page</a>`);
  });

  it("a topic page is a CollectionPage with an ItemList of the articles it shows (#1759)", async () => {
    const graph = graphOf(await preview(ids.topic));
    expect(node(graph, url("seo"))?.["@type"]).toBe("CollectionPage");
    expect(node(graph, `${url("seo")}#items`)).toEqual({
      "@type": "ItemList",
      "@id": `${url("seo")}#items`,
      itemListElement: [{ "@type": "ListItem", position: 1, url: url("graph") }],
      numberOfItems: 1,
    });
  });

  it("the build writes the preview's graph, dated from the live record, and every reference resolves", async () => {
    const built = [ids.article, ids.anna, ids.topic].map((pageId) => ({
      pageId,
      pageSlug: pageId,
      html: "<html><head><title>x</title></head><body>b</body></html>",
      listedPages: pageId === ids.topic ? [ids.article] : [],
    }));
    const { renderFailures } = await adapter.withAdminTransaction(SYS, (tx) =>
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
          siteName: "Example Blog",
          organization: { name: "Example GmbH", url: `${BASE}/` },
        },
        pageUrlStyle: "directory",
        notFoundPageId: null,
        unresolved: "report",
      }),
    );
    expect(renderFailures).toEqual([]);
    const undated = (nodes: Record<string, unknown>[]) =>
      nodes.map(({ datePublished: _p, dateModified: _m, ...rest }) => rest);
    for (const b of built) {
      const fromBuild = graphOf(b.html);
      const fromPreview = graphOf(await preview(b.pageId));
      expect(undated(fromBuild)).toEqual(undated(fromPreview));
    }
    const article = node(graphOf(built[0]?.html as string), `${url("graph")}#article`);
    expect(String(article?.datePublished)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(article?.dateModified).toBe(
      node(graphOf(built[0]?.html as string), url("graph"))?.dateModified,
    );
    // The Stage's integrity check finds nothing on these pages.
    const check = createStructuredDataCheck();
    const findings = await check.run({
      pages: built.map((b) => ({
        pageId: b.pageId,
        path: `/${b.pageId}`,
        url: `${BASE}/${b.pageId}`,
        html: b.html,
      })),
      build: {
        baseUrl: BASE,
        probe: async () => ({ found: true, status: 200 }),
        text: async () => null,
      },
    });
    expect(findings).toEqual([]);
  }, 120_000);

  it("a mapping set in a chat is a draft: its preview shows it, main keeps the old one", async () => {
    const chat = await run<{ chatSessionId: string; chatBranchId: string }>("chat.create_session", {
      title: `${PFX}-draft`,
      isolation: "experiment",
    });
    await seo(
      "set_schema_mappings_many",
      { mappings: [{ pageType: `${PFX}-author`, schemaType: "none" }] },
      {
        origin: "chat",
        actorId: SYSTEM_ID,
        operatorActorId: await owner(),
        chatBranchId: chat.chatBranchId,
        chatTaskId: chat.chatSessionId,
      },
    );
    const onBranch = node(graphOf(await preview(ids.anna, chat.chatBranchId)), url("anna"));
    expect(onBranch?.["@type"]).toBe("WebPage");
    const onMain = node(graphOf(await preview(ids.anna)), url("anna"));
    expect(onMain?.["@type"]).toBe("ProfilePage");
    await run("chat.discard_branch", { chatSessionId: chat.chatSessionId }).catch(() => undefined);
  }, 60_000);
});
