// SPDX-License-Identifier: MPL-2.0

/**
 * #1759 — `lists.merge_terms` against a real Postgres: one topic spelt as
 * two tags becomes one in one call. The pages carrying the merged tag carry
 * the kept tag (no page twice), the merged tag's topic page is deleted with
 * a 301 to the kept tag's topic page, and the merged tag leaves the
 * vocabulary. A merged tag whose kept tag has no topic page hands its page
 * over instead.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext, ListItem } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "system", requestId: "t1759mt" };
const PFX = `t1759mt${Date.now().toString(36)}`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";

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

async function page(slug: string, pageType: string, terms: string[] = []): Promise<string> {
  const { pageId } = await op<{ pageId: string }>(SYS, "pages.create", {
    slug: `${PFX}-${slug}`,
    title: slug,
    pageType,
    terms,
  });
  await op(SYS, "pages.set_status", { pageId, status: "published" });
  return pageId;
}

async function termsOf(ctx: ExecutionContext, pageIds: string[]): Promise<Map<string, string[]>> {
  const { pages } = await op<{ pages: { id: string; terms: string[] }[] }>(ctx, "pages.list", {
    includeDeleted: false,
    pageIds,
  });
  return new Map(pages.map((p) => [p.id, [...p.terms].sort()]));
}

let vocab = { id: "", slug: "", tools: "", tool: "", ads: "", adsense: "" };
let topicTools = "";
let topicTool = "";
let topicAdsense = "";
let articles: string[] = [];

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  templateId = (
    await op<{ templateId: string }>(SYS, "templates.create", {
      pageType: "home",
      slug: `${PFX}-tpl`,
      displayName: `${PFX} TPL`,
      html: `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    })
  ).templateId;
  await op(SYS, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const slug = `${PFX}-tags`;
  await op(SYS, "lists.upsert_many", {
    lists: [
      {
        slug,
        name: "Blog tags",
        purpose: "Topics articles are tagged with",
        type: "categories",
        items: [
          { node: "category", values: { name: "SEO Tools", slug: "seo-tools" } },
          { node: "category", values: { name: "SEO-Tool", slug: "seo-tool" } },
          { node: "category", values: { name: "Ads", slug: "ads" } },
          { node: "category", values: { name: "AdSense", slug: "adsense" } },
        ],
      },
    ],
  });
  const list = (await op<{ list: { id: string; items: ListItem[] } }>(SYS, "lists.get", { slug }))
    .list;
  const [tools, tool, ads, adsense] = list.items.map((i) => i.id);
  vocab = {
    id: list.id,
    slug,
    tools: tools ?? "",
    tool: tool ?? "",
    ads: ads ?? "",
    adsense: adsense ?? "",
  };
  const typeSlug = `${PFX}-article`;
  await op(SYS, "page_types.upsert_many", {
    pageTypes: [
      {
        slug: typeSlug,
        name: "Article",
        purpose: "Blog articles",
        collection: true,
        templates: [templateId],
        defaultTemplate: templateId,
        properties: [],
        vocabularies: [{ list: list.id, cardinality: "many" }],
      },
      {
        slug: `${PFX}-topic`,
        name: "Topic",
        purpose: "Curated topic pages",
        collection: false,
        templates: [templateId],
        defaultTemplate: templateId,
        properties: [],
        vocabularies: [],
      },
    ],
  });
  const term = (id: string) => `caelo:term/${list.id}/${id}`;
  topicTools = await page("topic-seo-tools", `${PFX}-topic`);
  topicTool = await page("topic-seo-tool", `${PFX}-topic`);
  topicAdsense = await page("topic-adsense", `${PFX}-topic`);
  await op(SYS, "lists.patch_items_many", {
    lists: [
      {
        slug,
        patches: [
          {
            op: "update",
            itemId: vocab.tools,
            values: { landing_page: { href: `caelo:page/${topicTools}` } },
          },
          {
            op: "update",
            itemId: vocab.tool,
            values: { landing_page: { href: `caelo:page/${topicTool}` } },
          },
          {
            op: "update",
            itemId: vocab.adsense,
            values: { landing_page: { href: `caelo:page/${topicAdsense}` } },
          },
        ],
      },
    ],
  });
  articles = [
    await page("a1", typeSlug, [term(vocab.tools)]),
    await page("a2", typeSlug, [term(vocab.tool)]),
    await page("a3", typeSlug, [term(vocab.tools), term(vocab.tool)]),
    await page("a4", typeSlug, [term(vocab.adsense)]),
  ];
}, 120_000);

afterAll(async () => {
  await asSystem(async (tx) => {
    await tx`UPDATE pages SET deleted_at = now() WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM pending_redirects WHERE from_path LIKE ${`%${PFX}%`}`;
    await tx`UPDATE page_types SET deleted_at = now() WHERE slug LIKE ${`${PFX}%`}`;
    await tx`UPDATE templates SET deleted_at = now() WHERE slug LIKE ${`${PFX}%`}`;
  });
  await adapter.close();
});

describe("#1759 lists.merge_terms", () => {
  it("re-tags the pages, redirects the merged term's topic page and removes the term, in one call", async () => {
    const term = (id: string) => `caelo:term/${vocab.id}/${id}`;
    const r = await op<{
      retaggedPages: number;
      removedTerms: number;
      adoptedOverviewPages: string[];
      redirectedOverviewPages: { pageId: string; to: string }[];
    }>(SYS, "lists.merge_terms", {
      list: vocab.slug,
      merges: [
        { from: [vocab.tool], into: vocab.tools },
        // Ads has no topic page: it takes AdSense's.
        { from: [vocab.adsense], into: vocab.ads },
      ],
    });
    expect(r.retaggedPages).toBe(3);
    expect(r.removedTerms).toBe(2);
    expect(r.adoptedOverviewPages).toEqual([topicAdsense]);
    expect(r.redirectedOverviewPages).toEqual([
      { pageId: topicTool, to: `/${PFX}-topic-seo-tools` },
    ]);

    const tags = await termsOf(SYS, articles);
    expect(tags.get(articles[0] as string)).toEqual([term(vocab.tools)]);
    expect(tags.get(articles[1] as string)).toEqual([term(vocab.tools)]);
    // Carried both: carries the kept one once.
    expect(tags.get(articles[2] as string)).toEqual([term(vocab.tools)]);
    expect(tags.get(articles[3] as string)).toEqual([term(vocab.ads)]);

    const list = (await op<{ list: { items: ListItem[] } }>(SYS, "lists.get", { slug: vocab.slug }))
      .list;
    expect(list.items.map((i) => i.values.name)).toEqual(["SEO Tools", "Ads"]);
    const ads = list.items.find((i) => i.values.name === "Ads");
    // Reads show page links as paths.
    expect((ads?.values.landing_page as { href: string } | undefined)?.href).toBe(
      `/${PFX}-topic-adsense`,
    );

    // #1550 — a page delete's 301 is Staged: it goes live with the Publish live that ships the delete.
    const redirects = await asSystem(
      (tx) =>
        tx`SELECT from_path, to_path FROM pending_redirects WHERE from_path = ${`/${PFX}-topic-seo-tool`}`,
    );
    expect(redirects).toHaveLength(1);
    expect((redirects as { to_path: string }[])[0]?.to_path).toBe(`/${PFX}-topic-seo-tools`);
    const gone = await termsOf(SYS, [topicTool]);
    expect(gone.has(topicTool)).toBe(false);
  });

  it("refuses a list that is no vocabulary, an unknown term and a merge in both directions", async () => {
    const fail = async (input: unknown) => {
      const r = await execute(registry, adapter, SYS, "lists.merge_terms", input);
      expect(r.ok).toBe(false);
      return r.ok ? "" : JSON.stringify(r.error);
    };
    expect(
      await fail({
        list: vocab.slug,
        merges: [{ from: [crypto.randomUUID()], into: vocab.tools }],
      }),
    ).toContain("has no term");
    expect(
      await fail({ list: vocab.slug, merges: [{ from: [vocab.tools], into: vocab.tools }] }),
    ).toContain("into itself");
    expect(
      await fail({
        list: vocab.slug,
        merges: [
          { from: [vocab.tools], into: vocab.ads },
          { from: [vocab.ads], into: vocab.tools },
        ],
      }),
    ).toContain("merge in one direction");
    expect(
      await fail({ list: `${PFX}-nope`, merges: [{ from: [vocab.tools], into: vocab.ads }] }),
    ).toContain("no list");
  });

  it("keeps a merged category's sub-categories under the kept one, and refuses merging a term into its own child", async () => {
    const slug = `${PFX}-tree`;
    await op(SYS, "lists.upsert_many", {
      lists: [
        {
          slug,
          name: "Blog categories",
          purpose: "Nested categories of the blog",
          type: "categories",
          items: [
            {
              node: "category",
              values: { name: "Marketing", slug: "marketing" },
              children: [
                { node: "category", values: { name: "Email", slug: "email" } },
                { node: "category", values: { name: "Social", slug: "social" } },
              ],
            },
            {
              node: "category",
              values: { name: "Online Marketing", slug: "online-marketing" },
              children: [{ node: "category", values: { name: "Search", slug: "search" } }],
            },
          ],
        },
      ],
    });
    const tree = (await op<{ list: { id: string; items: ListItem[] } }>(SYS, "lists.get", { slug }))
      .list;
    const marketing = tree.items[0] as ListItem;
    const online = tree.items[1] as ListItem;
    const email = marketing.children?.[0] as ListItem;

    const refused = await execute(registry, adapter, SYS, "lists.merge_terms", {
      list: slug,
      merges: [{ from: [marketing.id], into: email.id }],
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : JSON.stringify(refused.error)).toContain("sits under the merged term");

    const r = await op<{ removedTerms: number }>(SYS, "lists.merge_terms", {
      list: slug,
      merges: [{ from: [marketing.id], into: online.id }],
    });
    expect(r.removedTerms).toBe(1);
    const after = (await op<{ list: { items: ListItem[] } }>(SYS, "lists.get", { slug })).list;
    expect(after.items.map((i) => i.values.name)).toEqual(["Online Marketing"]);
    expect(after.items[0]?.children?.map((i) => i.values.name)).toEqual([
      "Search",
      "Email",
      "Social",
    ]);
    // The moved sub-categories keep their ids, so the pages filed under them keep their terms.
    expect(after.items[0]?.children?.[1]?.id).toBe(email.id);
  });

  it("removes a merged grandchild whose parent stays, in one merge and across two", async () => {
    // A > B > C, K1, K2: B is not merged, so it moves and C must not ride along.
    const tree = async (slug: string) => {
      await op(SYS, "lists.upsert_many", {
        lists: [
          {
            slug,
            name: slug,
            purpose: "Nested categories for the merge test",
            type: "categories",
            items: [
              {
                node: "category",
                values: { name: "A", slug: "a" },
                children: [
                  {
                    node: "category",
                    values: { name: "B", slug: "b" },
                    children: [{ node: "category", values: { name: "C", slug: "c" } }],
                  },
                ],
              },
              { node: "category", values: { name: "K1", slug: "k1" } },
              { node: "category", values: { name: "K2", slug: "k2" } },
            ],
          },
        ],
      });
      const items = (await op<{ list: { items: ListItem[] } }>(SYS, "lists.get", { slug })).list
        .items;
      const a = items[0] as ListItem;
      const b = a.children?.[0] as ListItem;
      return {
        a,
        b,
        c: b.children?.[0] as ListItem,
        k1: items[1] as ListItem,
        k2: items[2] as ListItem,
      };
    };
    const shape = async (slug: string) => {
      const items = (await op<{ list: { items: ListItem[] } }>(SYS, "lists.get", { slug })).list
        .items;
      const walk = (xs: readonly ListItem[]): unknown[] =>
        xs.map((x) =>
          x.children && x.children.length > 0
            ? { [x.values.name as string]: walk(x.children) }
            : x.values.name,
        );
      return walk(items);
    };

    const one = `${PFX}-nest-one`;
    const t1 = await tree(one);
    const r1 = await op<{ removedTerms: number }>(SYS, "lists.merge_terms", {
      list: one,
      merges: [{ from: [t1.a.id, t1.c.id], into: t1.k1.id }],
    });
    expect(r1.removedTerms).toBe(2);
    expect(await shape(one)).toEqual([{ K1: ["B"] }, "K2"]);

    const two = `${PFX}-nest-two`;
    const t2 = await tree(two);
    const r2 = await op<{ removedTerms: number }>(SYS, "lists.merge_terms", {
      list: two,
      merges: [
        { from: [t2.a.id], into: t2.k1.id },
        { from: [t2.c.id], into: t2.k2.id },
      ],
    });
    expect(r2.removedTerms).toBe(2);
    expect(await shape(two)).toEqual([{ K1: ["B"] }, "K2"]);
  });
});
