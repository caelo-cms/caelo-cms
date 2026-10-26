// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 part E — `lists.preview_source` against a real Postgres: a
 * page query, a system source (breadcrumbs, term_pages), a query node
 * stored in a shared list (a mega menu's "latest news" column) and a
 * module's source field all answer with the published pages the render
 * would show, links as paths; wrong names come back AI-actionable.
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
const PFX = "t1107ps-";
const SYS: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "system", requestId: "t1107ps" };

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
  return "message" in r.error ? r.error.message : JSON.stringify(r.error);
}

type Preview = { source: string; count: number; items: Record<string, unknown>[] };

const NEWS = `${PFX}news`;
let catGuides = "";
let catEngineering = "";
let parentPageId = "";
let childPageId = "";

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  // Templates, list types and page types are seed-bearing (kept across
  // files by the test reset): drop what an earlier run left behind.
  await asSystem(async (tx) => {
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}%`}`;
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

  // A categories vocabulary, a news page type on a template of its own,
  // three published articles (two in Guides) and a draft one.
  const vocab = await op<{ lists: { id: string }[] }>(SYS, "lists.upsert_many", {
    lists: [
      {
        slug: `${PFX}cats`,
        name: "Blog categories",
        purpose: "Sections of the blog",
        type: "categories",
        items: [
          { node: "category", values: { name: "Guides", slug: "guides" } },
          { node: "category", values: { name: "Engineering", slug: "engineering" } },
        ],
      },
    ],
  });
  const vocabId = vocab.lists[0]?.id ?? "";
  const items = (
    await op<{ list: { items: { id: string }[] } }>(SYS, "lists.get", { slug: `${PFX}cats` })
  ).list.items;
  catGuides = `caelo:term/${vocabId}/${items[0]?.id}`;
  catEngineering = `caelo:term/${vocabId}/${items[1]?.id}`;
  const { templateId } = await op<{ templateId: string }>(SYS, "templates.create", {
    slug: `${PFX}news-tpl`,
    displayName: "News",
    html: '<main><caelo-slot name="content"></caelo-slot></main>',
  });
  await op(SYS, "page_types.upsert_many", {
    pageTypes: [
      {
        slug: NEWS,
        name: "News",
        purpose: "Dated news articles",
        templates: [templateId],
        defaultTemplate: templateId,
        properties: [],
        vocabularies: [{ list: vocabId, cardinality: "many" }],
      },
    ],
  });
  const article = (slug: string, title: string, terms: string[], status = "published") =>
    op<{ pageId: string }>(SYS, "pages.create", {
      slug: `${PFX}${slug}`,
      title,
      pageType: NEWS,
      templateId,
      status,
      terms,
    });
  parentPageId = (await article("a", "Alpha release", [catGuides])).pageId;
  await article("b", "Beta notes", [catGuides, catEngineering]);
  await article("c", "Compiler deep dive", [catEngineering]);
  await article("d", "Draft idea", [catGuides], "draft");
  childPageId = (
    await op<{ pageId: string }>(SYS, "pages.create", {
      slug: `${PFX}child`,
      title: "Alpha FAQ",
      pageType: NEWS,
      templateId,
      status: "published",
      parentPageId,
    })
  ).pageId;
});

afterAll(async () => {
  await adapter.close();
});

describe("#1107 lists.preview_source", () => {
  it("a page query returns the published pages of the type, in order, links as paths", async () => {
    const v = await op<Preview>(SYS, "lists.preview_source", {
      source: {
        kind: "query",
        editable: ["limit"],
        defaults: { page_type: NEWS, order: "title_asc", limit: 3 },
      },
    });
    expect(v.items.map((e) => e.title)).toEqual(["Alpha FAQ", "Alpha release", "Beta notes"]);
    expect(v.items[1]?.link).toBe(`/${PFX}a`);
    expect(v.items[0]?.page_type).toBe(NEWS);
    // The placement may override an editable knob — and only those.
    const two = await op<Preview>(SYS, "lists.preview_source", {
      source: {
        kind: "query",
        editable: ["limit"],
        defaults: { page_type: NEWS, order: "title_asc", limit: 3 },
      },
      value: { limit: 1 },
    });
    expect(two.count).toBe(1);
    const notEditable = await fail(SYS, "lists.preview_source", {
      source: { kind: "query", editable: ["limit"], defaults: { page_type: NEWS, limit: 3 } },
      value: { page_type: "page" },
    });
    expect(notEditable).toContain("list-malformed");
    expect(notEditable).toContain("editable");
  });

  it("a query filters by terms; drafts never appear", async () => {
    const v = await op<Preview>(SYS, "lists.preview_source", {
      source: {
        kind: "query",
        editable: [],
        defaults: { page_type: NEWS, terms: [catGuides], order: "title_asc", limit: 10 },
      },
    });
    expect(v.items.map((e) => e.title)).toEqual(["Alpha release", "Beta notes"]);
  });

  it("system sources read the given page: breadcrumbs and term_pages", async () => {
    const crumbs = await op<Preview>(SYS, "lists.preview_source", {
      pageId: childPageId,
      source: { kind: "system", name: "breadcrumbs" },
    });
    expect(crumbs.items.map((e) => e.title)).toEqual(["Alpha release", "Alpha FAQ"]);
    expect(crumbs.items[1]?.is_current).toBe(true);
    const tagged = await op<Preview>(SYS, "lists.preview_source", {
      source: { kind: "system", name: "term_pages" },
      value: { terms: [catEngineering] },
    });
    expect(tagged.items.map((e) => e.title)).toEqual(["Beta notes", "Compiler deep dive"]);
  });

  it("a query node stored in a shared list (a mega menu's latest-news column)", async () => {
    await op(SYS, "list_types.upsert_many", {
      listTypes: [
        {
          slug: `${PFX}mega`,
          name: "Mega menu",
          purpose: "Header navigation with columns and the latest news",
          role: "navigation",
          root: { allow: ["column"] },
          nodes: {
            column: {
              label: "Column",
              fields: [{ name: "heading", type: "text", label: "Heading", required: true }],
              children: { name: "links", allow: ["news"] },
            },
            news: {
              label: "Latest news",
              fields: [],
              source: {
                kind: "query",
                editable: ["limit"],
                defaults: { page_type: NEWS, order: "title_asc", limit: 3 },
              },
            },
          },
        },
      ],
    });
    const written = await op<{
      lists: { id: string; sourceEntries: { id: string; node: string }[] }[];
    }>(SYS, "lists.upsert_many", {
      lists: [
        {
          slug: `${PFX}header`,
          name: "Header",
          purpose: "Main navigation",
          type: `${PFX}mega`,
          items: [
            {
              node: "column",
              values: { heading: "News" },
              children: [{ node: "news", values: {}, query: { limit: 2 } }],
            },
          ],
        },
      ],
    });
    const list = (
      await op<{ list: { items: { children: { id: string }[] }[] } }>(SYS, "lists.get", {
        slug: `${PFX}header`,
      })
    ).list;
    const newsNode = list.items[0]?.children[0]?.id ?? "";
    const v = await op<Preview>(SYS, "lists.preview_source", {
      list: `${PFX}header`,
      itemId: newsNode,
    });
    // The entry's saved query (limit 2) applies over the type's defaults.
    expect(v.items.map((e) => e.title)).toEqual(["Alpha FAQ", "Alpha release"]);
    // e2e-livedit run 40344374447 — the list's reference, the form module
    // fields and `vocabulary` use, names the same list as its slug.
    const byRef = await op<Preview>(SYS, "lists.preview_source", {
      list: `caelo:list/${written.lists[0]?.id}`,
      itemId: newsNode,
    });
    expect(byRef.items.map((e) => e.title)).toEqual(["Alpha FAQ", "Alpha release"]);
    // The list editor previews a node kind with the knobs being edited,
    // before the entry is saved.
    const editing = await op<Preview>(SYS, "lists.preview_source", {
      list: `${PFX}header`,
      node: "news",
      value: { limit: 1 },
    });
    expect(editing.items.map((e) => e.title)).toEqual(["Alpha FAQ"]);
    const notSource = await fail(SYS, "lists.preview_source", {
      list: `${PFX}header`,
      node: "column",
    });
    expect(notSource).toContain("source node kinds: news");
    const missing = await fail(SYS, "lists.preview_source", {
      list: `${PFX}header`,
      itemId: crypto.randomUUID(),
    });
    expect(missing).toContain("no such entry");
    // PR #1121 e2e — the write result names the source entries, and the
    // list's own id passed as itemId is refused with the right ids.
    expect(written.lists[0]?.sourceEntries).toEqual([{ id: newsNode, node: "news" }]);
    const ownId = await fail(SYS, "lists.preview_source", {
      list: `${PFX}header`,
      itemId: written.lists[0]?.id,
    });
    expect(ownId).toContain("the list's own id");
    expect(ownId).toContain(`${newsNode} (news)`);
  });

  it("a module's source field, with a placement's overrides; a stored field is refused", async () => {
    const moduleId = crypto.randomUUID();
    const field = {
      name: "latest",
      label: "Latest news",
      kind: "list",
      listType: "links",
      bind: "source",
      source: {
        kind: "query",
        editable: ["limit"],
        defaults: { page_type: NEWS, order: "title_asc", limit: 3 },
      },
    };
    const stored = { name: "links", label: "Links", kind: "list", listType: "links" };
    await asSystem(async (tx) => {
      await tx`
        INSERT INTO modules (id, slug, display_name, html, fields, type)
        VALUES (${moduleId}::uuid, ${`${PFX}latest`}, 'Latest news', '<ul>{{#latest}}<li>{{title}}</li>{{/latest}}</ul>',
                ${JSON.stringify([field, stored])}::jsonb, 'latest-news')`;
    });
    const instanceId = (
      await asSystem(
        (tx) =>
          tx`INSERT INTO content_instances (module_id, "values") VALUES (${moduleId}::uuid, ${JSON.stringify({ latest: { limit: 1 } })}::jsonb) RETURNING id::text AS id`,
      )
    )[0]?.id as string;
    const all = await op<Preview>(SYS, "lists.preview_source", { moduleId, field: "latest" });
    expect(all.count).toBe(3);
    const placed = await op<Preview>(SYS, "lists.preview_source", {
      moduleId,
      field: "latest",
      contentInstanceId: instanceId,
    });
    expect(placed.count).toBe(1);
    const notSource = await fail(SYS, "lists.preview_source", { moduleId, field: "links" });
    expect(notSource).toContain("bound local, not to a source");
  });

  it("names the source exactly one way", async () => {
    const msg = await fail(SYS, "lists.preview_source", {
      list: `${PFX}header`,
      source: { kind: "system", name: "children" },
    });
    expect(msg).toContain("exactly one way");
  });
});
