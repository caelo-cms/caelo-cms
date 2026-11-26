// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1754 against a real Postgres: page references.
 *
 * An `author` page type and an `article` page type whose `authors`
 * property names authors in order. The writes take paths (what reads
 * show) and store references, refuse a page that does not exist, one of
 * the wrong type and the page itself; a rename or move of the author leaves
 * the reference as stored and the read shows the new path; the author page
 * lists the articles naming it (`refers_to: self`); a term's overview
 * page leads the breadcrumbs; the page types guard their relations.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ID = "00000000-0000-0000-0000-00000000ffff";
const PFX = "t1754pr-";
const SYS: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "system", requestId: "t1754pr" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
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

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function fail(ctx: ExecutionContext, name: string, input: unknown): Promise<string> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (r.ok) throw new Error(`${name} unexpectedly succeeded: ${JSON.stringify(r.value)}`);
  return JSON.stringify(r.error);
}

async function storedProperties(pageId: string): Promise<Record<string, unknown>> {
  const rows = await asSystem((tx) => tx`SELECT properties FROM pages WHERE id = ${pageId}::uuid`);
  return (rows as { properties: Record<string, unknown> }[])[0]?.properties ?? {};
}

const AUTHOR = `${PFX}author`;
const ARTICLE = `${PFX}article`;
const ref = (id: string): string => `caelo:page/${id}`;
let templateId = "";
let topicsId = "";
let seoTerm = "";
const P = { anna: "", ben: "", seo: "", post1: "", post2: "" };

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  // Templates, list types and page types are seed-bearing (kept across
  // files by the test reset): drop what an earlier run left behind.
  await asSystem(async (tx) => {
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM lists WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM list_types WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM page_types WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}%`}`;
    await tx`
      UPDATE page_types pt SET definition = jsonb_set(pt.definition, '{templates}', (
        SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM jsonb_array_elements(pt.definition->'templates') t
        WHERE EXISTS (SELECT 1 FROM templates x WHERE x.id::text = t #>> '{}')))`;
  });
  const topics = await op<{ lists: { id: string }[] }>(SYS, "lists.upsert_many", {
    lists: [
      {
        slug: `${PFX}topics`,
        name: "Topics",
        purpose: "What articles are about",
        type: "categories",
        items: [{ node: "category", values: { name: "SEO", slug: "seo" } }],
      },
    ],
  });
  topicsId = topics.lists[0]?.id ?? "";
  const items = (
    await op<{ list: { items: { id: string }[] } }>(SYS, "lists.get", { slug: `${PFX}topics` })
  ).list.items;
  seoTerm = `caelo:term/${topicsId}/${items[0]?.id}`;
  templateId = (
    await op<{ templateId: string }>(SYS, "templates.create", {
      pageType: "home",
      slug: `${PFX}tpl`,
      displayName: "Article",
      html: '<main><caelo-slot name="content"></caelo-slot></main>',
    })
  ).templateId;
});

afterAll(async () => {
  await adapter.close();
});

describe("page types with page references", () => {
  it("refuses a property asking for a page type that does not exist", async () => {
    const msg = await fail(SYS, "page_types.upsert_many", {
      pageTypes: [
        {
          slug: `${PFX}orphan`,
          name: "Orphan",
          purpose: "x",
          collection: true,
          templates: [templateId],
          defaultTemplate: templateId,
          properties: [
            { name: "authors", label: "Authors", type: "page", pageType: `${PFX}nobody` },
          ],
        },
      ],
    });
    expect(msg).toContain(`takes pages of page type \\"${PFX}nobody\\", which does not exist`);
  });

  it("creates the author type and the article type naming it in one call", async () => {
    await op(SYS, "page_types.upsert_many", {
      pageTypes: [
        {
          slug: ARTICLE,
          name: "Article",
          purpose: "Blog articles with their authors",
          collection: true,
          templates: [templateId],
          defaultTemplate: templateId,
          properties: [
            { name: "authors", label: "Authors", type: "page", pageType: AUTHOR, multiple: true },
            { name: "reviewed_by", label: "Reviewed by", type: "page", pageType: AUTHOR },
          ],
          vocabularies: [{ list: topicsId, cardinality: "many" }],
        },
        {
          slug: AUTHOR,
          name: "Author",
          purpose: "A person who writes for the site",
          collection: true,
          templates: [templateId],
          defaultTemplate: templateId,
          properties: [{ name: "role", label: "Role", type: "text" }],
        },
      ],
    });
    const page = (slug: string, title: string, pageType: string, extra: object = {}) =>
      op<{ pageId: string }>(SYS, "pages.create", {
        slug: `${PFX}${slug}`,
        title,
        pageType,
        templateId,
        status: "published",
        ...extra,
      });
    P.anna = (await page("anna", "Anna", AUTHOR, { properties: { role: "Editor" } })).pageId;
    P.ben = (await page("ben", "Ben", AUTHOR)).pageId;
    P.seo = (await page("seo", "SEO topic", "home")).pageId;
  });
});

describe("writing a page property", () => {
  it("takes paths and ids, stores references in the given order, reads paths", async () => {
    P.post1 = (
      await op<{ pageId: string }>(SYS, "pages.create", {
        slug: `${PFX}post-1`,
        title: "Post one",
        pageType: ARTICLE,
        templateId,
        status: "published",
        properties: { authors: [`/${PFX}ben`, P.anna] },
        terms: [seoTerm],
      })
    ).pageId;
    expect((await storedProperties(P.post1)).authors).toEqual([ref(P.ben), ref(P.anna)]);
    const read = await op<{ page: { properties: Record<string, unknown> } }>(
      SYS,
      "pages.get_with_modules",
      {
        pageId: P.post1,
      },
    );
    expect(read.page.properties.authors).toEqual([`/${PFX}ben`, `/${PFX}anna`]);
    // Writing back what the read returned changes nothing.
    await op(SYS, "pages.update", { pageId: P.post1, properties: read.page.properties });
    expect((await storedProperties(P.post1)).authors).toEqual([ref(P.ben), ref(P.anna)]);
  });

  it("refuses a page that does not exist, one of another type, the page itself, two in one", async () => {
    const update = (properties: Record<string, unknown>) =>
      fail(SYS, "pages.update", { pageId: P.post1, properties });
    expect(await update({ authors: [`/${PFX}nobody`] })).toContain(`names no page of this site`);
    expect(await update({ authors: [`/${PFX}seo`] })).toContain(
      `this property takes pages of page type \\"${AUTHOR}\\"`,
    );
    expect(await update({ authors: [ref(P.post1)] })).toContain("a page cannot name itself");
    expect(await update({ reviewed_by: [ref(P.anna), ref(P.ben)] })).toContain("at most one page");
    // The refusals wrote nothing.
    expect((await storedProperties(P.post1)).authors).toEqual([ref(P.ben), ref(P.anna)]);
  });

  it("a renamed author keeps the reference; the read shows the new path", async () => {
    await op(SYS, "pages.update", { pageId: P.anna, slug: `${PFX}anna-k` });
    expect((await storedProperties(P.post1)).authors).toEqual([ref(P.ben), ref(P.anna)]);
    const read = await op<{ page: { properties: Record<string, unknown> } }>(
      SYS,
      "pages.get_with_modules",
      {
        pageId: P.post1,
      },
    );
    expect(read.page.properties.authors).toEqual([`/${PFX}ben`, `/${PFX}anna-k`]);
  });

  it("a moved author keeps the reference too", async () => {
    await op(SYS, "pages.move_many", { moves: [{ pageId: P.anna, parentPageId: P.ben }] });
    expect((await storedProperties(P.post1)).authors).toEqual([ref(P.ben), ref(P.anna)]);
    const read = await op<{ page: { properties: Record<string, unknown> } }>(
      SYS,
      "pages.get_with_modules",
      { pageId: P.post1 },
    );
    expect(read.page.properties.authors).toEqual([`/${PFX}ben`, `/${PFX}ben/${PFX}anna-k`]);
  });
});

describe("pages naming a page", () => {
  type Preview = { count: number; total: number; items: { title?: string }[] };
  const ARTICLES_OF_SELF = {
    kind: "query",
    editable: [],
    defaults: {
      page_type: ARTICLE,
      refers_to: { property: "authors", page: "self" },
      order: "title_asc",
      limit: 10,
    },
  };

  it("an author page lists the articles naming it, a new article included", async () => {
    P.post2 = (
      await op<{ pageId: string }>(SYS, "pages.create", {
        slug: `${PFX}post-2`,
        title: "Post two",
        pageType: ARTICLE,
        templateId,
        status: "published",
        properties: { authors: [`/${PFX}ben/${PFX}anna-k`] },
      })
    ).pageId;
    const anna = await op<Preview>(SYS, "lists.preview_source", {
      source: ARTICLES_OF_SELF,
      pageId: P.anna,
    });
    expect(anna.items.map((i) => i.title)).toEqual(["Post one", "Post two"]);
    const ben = await op<Preview>(SYS, "lists.preview_source", {
      source: ARTICLES_OF_SELF,
      pageId: P.ben,
    });
    expect(ben.items.map((i) => i.title)).toEqual(["Post one"]);
  });

  it("a fixed page works on any page, set by the placement", async () => {
    const r = await op<Preview>(SYS, "lists.preview_source", {
      source: { ...ARTICLES_OF_SELF, editable: ["refers_to"] },
      value: { refers_to: { property: "authors", page: ref(P.ben) } },
    });
    expect(r.items.map((i) => i.title)).toEqual(["Post one"]);
  });

  it("names a property no page type declares as a page property", async () => {
    const msg = await fail(SYS, "lists.preview_source", {
      source: {
        ...ARTICLES_OF_SELF,
        defaults: { ...ARTICLES_OF_SELF.defaults, refers_to: { property: "author", page: "self" } },
      },
      pageId: P.anna,
    });
    expect(msg).toContain('no page type has a page property \\"author\\"');
  });
});

describe("a term's overview page", () => {
  it("every vocabulary type has the field; one without it is refused", async () => {
    const tags = await op<{
      listType: {
        definition: { nodes: Record<string, { fields: { name: string; type: string }[] }> };
      };
    }>(SYS, "list_types.get", { slug: "tags" });
    expect(
      tags.listType.definition.nodes.tag?.fields.find((f) => f.name === "landing_page")?.type,
    ).toBe("link");
    const msg = await fail(SYS, "list_types.upsert_many", {
      listTypes: [
        {
          slug: `${PFX}labels`,
          name: "Labels",
          purpose: "x",
          role: "vocabulary",
          root: { allow: ["label"] },
          nodes: {
            label: {
              label: "Label",
              fields: [
                { name: "name", label: "Name", type: "text" },
                { name: "slug", label: "Slug", type: "text" },
              ],
            },
          },
        },
      ],
    });
    expect(msg).toContain('a link field \\"landing_page\\"');
  });

  it("breadcrumbs given the vocabulary lead through the term's overview page", async () => {
    const list = await op<{ list: { version: number; items: { id: string }[] } }>(
      SYS,
      "lists.get",
      { slug: `${PFX}topics` },
    );
    await op(SYS, "lists.patch_items_many", {
      lists: [
        {
          slug: `${PFX}topics`,
          patches: [
            {
              op: "update",
              itemId: list.list.items[0]?.id,
              values: { landing_page: { href: `/${PFX}seo` } },
            },
          ],
        },
      ],
    });
    const crumbs = await op<{ items: { title?: string }[] }>(SYS, "lists.preview_source", {
      source: { kind: "system", name: "breadcrumbs" },
      vocabulary: `caelo:list/${topicsId}`,
      pageId: P.post1,
    });
    expect(crumbs.items.map((i) => i.title).slice(-2)).toEqual(["SEO topic", "Post one"]);
    const plain = await op<{ items: { title?: string }[] }>(SYS, "lists.preview_source", {
      source: { kind: "system", name: "breadcrumbs" },
      pageId: P.post1,
    });
    expect(plain.items.map((i) => i.title)).not.toContain("SEO topic");
  });
});

describe("page types guard their relations", () => {
  it("refuses to delete a page type a page property asks for", async () => {
    const msg = await fail(SYS, "page_types.delete_many", { slugs: [AUTHOR] });
    expect(msg).toContain(`${ARTICLE}.authors, ${ARTICLE}.reviewed_by`);
  });

  it("narrowing a property re-checks the pages of the type", async () => {
    const types = await op<{
      pageTypes: { slug: string; version: number; definition?: unknown }[];
    }>(SYS, "page_types.list", {});
    const article = types.pageTypes.find((t) => t.slug === ARTICLE) as unknown as Record<
      string,
      unknown
    > & { version: number };
    const {
      id: _id,
      version,
      updatedAt: _u,
      pageCount: _c,
      vocabularySlugs: _v,
      ...def
    } = article as Record<string, unknown> & { version: number };
    const msg = await fail(SYS, "page_types.upsert_many", {
      pageTypes: [
        {
          ...def,
          expectedVersion: version,
          properties: [
            // Authors must now be article pages: Post one names two authors.
            { name: "authors", label: "Authors", type: "page", pageType: ARTICLE, multiple: true },
            { name: "reviewed_by", label: "Reviewed by", type: "page", pageType: AUTHOR },
          ],
        },
      ],
    });
    expect(msg).toContain("would not fit the new definition");
    expect(msg).toContain(`this property takes pages of page type \\"${ARTICLE}\\"`);
  });
});
