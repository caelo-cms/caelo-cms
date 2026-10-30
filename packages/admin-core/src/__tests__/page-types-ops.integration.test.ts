// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 part B — page types, page properties and terms against a
 * real Postgres: the type inferred from the template, properties and
 * terms validated against the type, branch overlay of a page's type
 * state, undo / revert restoring type + properties + terms, re-checking a
 * type's pages on change (`dropValues`), template ops carrying the page
 * type, `first_published_at`, and the render-data loader's two scopes.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { createTemplateTool } from "../ai/tools/create-template.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { loadListRenderData } from "../lists/load.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ID = "00000000-0000-0000-0000-00000000ffff";
const PFX = "t1107pt-";
const SYS: ExecutionContext = { actorId: SYSTEM_ID, actorKind: "system", requestId: "t1107pt" };

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

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  // Templates and page types are seed-bearing (kept across files by the
  // test reset): drop what an earlier run of this file left behind.
  await asSystem(async (tx) => {
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM deploy_runs WHERE target_id IN (SELECT id FROM deploy_targets WHERE name LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM deploy_targets WHERE name LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM page_types WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}%`}`;
    await tx`
      UPDATE page_types pt SET definition = jsonb_set(pt.definition, '{templates}', (
        SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) FROM jsonb_array_elements(pt.definition->'templates') t
        WHERE EXISTS (SELECT 1 FROM templates x WHERE x.id::text = t #>> '{}')))`;
  });
});

afterAll(async () => {
  // deploy_targets is kept across files by the test reset: a leftover
  // production target would be one more target later files' builds see
  // (the plugin-data build refuses while any production target has no
  // live build).
  await asSystem(async (tx) => {
    await tx`DELETE FROM deploy_runs WHERE target_id IN (SELECT id FROM deploy_targets WHERE name LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM deploy_targets WHERE name LIKE ${`${PFX}%`}`;
  });
  await adapter.close();
});

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

async function chat(title: string): Promise<{ id: string; branch: string; ctx: ExecutionContext }> {
  const v = await op<{ chatSessionId: string; chatBranchId: string }>(SYS, "chat.create_session", {
    title: `${PFX}${title}`,
  });
  return {
    id: v.chatSessionId,
    branch: v.chatBranchId,
    ctx: {
      actorId: SYSTEM_ID,
      actorKind: "ai",
      requestId: `t1107pt-${title}`,
      chatBranchId: v.chatBranchId,
      chatTaskId: v.chatSessionId,
    },
  };
}

type PageOut = {
  page: {
    pageType: string;
    properties: Record<string, unknown>;
    terms: string[];
    templateId: string;
  };
};

async function page(ctx: ExecutionContext, pageId: string): Promise<PageOut["page"]> {
  return (await op<PageOut>(ctx, "pages.get", { pageId })).page;
}

/** A News page type with a template of its own, a category vocabulary and two properties. */
async function seedNews(suffix: string): Promise<{
  templateId: string;
  vocabId: string;
  catA: string;
  catB: string;
  typeSlug: string;
}> {
  const vocab = await op<{ lists: { id: string }[] }>(SYS, "lists.upsert_many", {
    lists: [
      {
        slug: `${PFX}cats-${suffix}`,
        name: "Blog categories",
        purpose: "Sections of the blog",
        type: "categories",
        items: [
          { node: "category", values: { name: "Product", slug: "product" } },
          { node: "category", values: { name: "Company", slug: "company" } },
        ],
      },
    ],
  });
  const vocabId = vocab.lists[0]?.id ?? "";
  const items = (
    await op<{ list: { items: { id: string }[] } }>(SYS, "lists.get", {
      slug: `${PFX}cats-${suffix}`,
    })
  ).list.items;
  const typeSlug = `${PFX}news-${suffix}`;
  // #1276 — the type and its first template in one call.
  const { templateId } = await op<{ templateId: string }>(SYS, "templates.create", {
    slug: `${PFX}news-tpl-${suffix}`,
    displayName: "News",
    html: '<main><caelo-slot name="content"></caelo-slot></main>',
    newPageType: {
      slug: typeSlug,
      name: "News",
      purpose: "Dated news articles",
      collection: true,
      properties: [
        { name: "teaser", label: "Teaser", type: "text" },
        { name: "featured", label: "Featured", type: "boolean", default: false },
      ],
      vocabularies: [{ list: vocabId, cardinality: "one", required: true }],
    },
  });
  return {
    templateId,
    vocabId,
    catA: `caelo:term/${vocabId}/${items[0]?.id}`,
    catB: `caelo:term/${vocabId}/${items[1]?.id}`,
    typeSlug,
  };
}

describe("#1107 page types", () => {
  it("seeds one page type per template kind; site defaults hold no page type (#1276)", async () => {
    const v = await op<{ pageTypes: { slug: string; templates: string[] }[] }>(
      SYS,
      "page_types.list",
      {},
    );
    const tpl = await op<{ templates: { id: string; slug: string }[] }>(SYS, "templates.list", {});
    const home = tpl.templates.find((t) => t.slug === "home-template");
    expect(v.pageTypes.find((t) => t.slug === "home")?.templates).toContain(home?.id ?? "-");
    const defaults = await op<{ defaults: Record<string, unknown> }>(SYS, "site_defaults.get", {});
    expect(defaults.defaults).not.toHaveProperty("defaultPageTypeId");
    expect(defaults.defaults).not.toHaveProperty("defaultTemplateId");
  });

  it("creates a page with its type from the template, properties with defaults, validated terms", async () => {
    const news = await seedNews("a");
    // Put the news template in a second type too: a template alone then
    // cannot say which type is meant.
    await op(SYS, "templates.update", { templateId: news.templateId, pageType: "home" });
    const ambiguous = await fail(SYS, "pages.create", {
      slug: `${PFX}n1`,
      title: "N1",
      templateId: news.templateId,
    });
    expect(ambiguous).toContain("pass pageType");
    // A template only the news type lists decides the type on its own.
    const { templateId: newsOnly } = await op<{ templateId: string }>(SYS, "templates.create", {
      slug: `${PFX}news-only-a`,
      displayName: "News only",
      html: '<main><caelo-slot name="content"></caelo-slot></main>',
      pageType: news.typeSlug,
    });
    const missingTerm = await fail(SYS, "pages.create", {
      slug: `${PFX}n1`,
      title: "N1",
      templateId: newsOnly,
    });
    expect(missingTerm).toContain("requires a term");
    const badProp = await fail(SYS, "pages.create", {
      slug: `${PFX}n1`,
      title: "N1",
      pageType: news.typeSlug,
      properties: { nope: 1 },
      terms: [news.catA],
    });
    expect(badProp).toContain('declares no property "nope"');
    const two = await fail(SYS, "pages.create", {
      slug: `${PFX}n1`,
      title: "N1",
      pageType: news.typeSlug,
      terms: [news.catA, news.catB],
    });
    expect(two).toContain("takes one term");

    const { pageId } = await op<{ pageId: string }>(SYS, "pages.create", {
      slug: `${PFX}n1`,
      title: "N1",
      templateId: newsOnly,
      properties: { teaser: "Hello" },
      terms: [news.catA],
    });
    expect(await page(SYS, pageId)).toMatchObject({
      pageType: news.typeSlug,
      properties: { teaser: "Hello", featured: false },
      terms: [news.catA],
    });
  });

  it("keeps a chat's type edits in its branch; undo drops them; revert_page restores a live change", async () => {
    const news = await seedNews("b");
    const { pageId } = await op<{ pageId: string }>(SYS, "pages.create", {
      slug: `${PFX}n2`,
      title: "N2",
      pageType: news.typeSlug,
      terms: [news.catA],
    });
    const a = await chat("page editor");
    await op(a.ctx, "pages.update", {
      pageId,
      properties: { teaser: "Draft teaser", featured: true },
      terms: [news.catB],
    });
    expect(await page(a.ctx, pageId)).toMatchObject({
      properties: { teaser: "Draft teaser", featured: true },
      terms: [news.catB],
    });
    expect(await page(SYS, pageId)).toMatchObject({
      properties: { featured: false },
      terms: [news.catA],
    });
    const listed = await op<{ pages: { id: string; terms: string[] }[] }>(a.ctx, "pages.list", {});
    expect(listed.pages.find((p) => p.id === pageId)?.terms).toEqual([news.catB]);

    await op(SYS, "chat.undo_changes", { chatSessionId: a.id });
    expect(await page(a.ctx, pageId)).toMatchObject({ terms: [news.catA] });

    // Live change, then revert_page to the creating snapshot.
    const snap = await asSystem(
      (tx) =>
        tx`
        SELECT ss.id::text AS id FROM site_snapshots ss
        JOIN page_snapshots ps ON ps.site_snapshot_id = ss.id
        WHERE ps.page_id = ${pageId}::uuid AND ss.chat_branch_id IS NULL
        ORDER BY ss.created_at LIMIT 1` as Promise<{ id: string }[]>,
    );
    await op(SYS, "pages.update", { pageId, properties: { teaser: "Live" }, terms: [news.catB] });
    expect(await page(SYS, pageId)).toMatchObject({
      properties: { teaser: "Live" },
      terms: [news.catB],
    });
    await op(SYS, "snapshots.revert_page", { pageId, snapshotId: snap[0]?.id });
    const reverted = await page(SYS, pageId);
    expect(reverted.terms).toEqual([news.catA]);
    expect(reverted.properties).not.toHaveProperty("teaser");
  });

  it("stages a page's terms into page_terms", async () => {
    const news = await seedNews("c");
    const { pageId } = await op<{ pageId: string }>(SYS, "pages.create", {
      slug: `${PFX}n3`,
      title: "N3",
      pageType: news.typeSlug,
      terms: [news.catA],
    });
    const a = await chat("terms stage");
    await op(a.ctx, "pages.update", { pageId, terms: [news.catB] });
    await op(SYS, "chat.merge_draft_to_main", { chatSessionIds: [a.id] });
    const rows = await asSystem(
      (tx) =>
        tx`SELECT item_id::text AS item FROM page_terms WHERE page_id = ${pageId}::uuid` as Promise<
          { item: string }[]
        >,
    );
    expect(rows.map((r) => `caelo:term/${news.vocabId}/${r.item}`)).toEqual([news.catB]);
  });

  it("re-checks a type's pages: a dropped property is refused, accepted with dropValues; a new default is written", async () => {
    const news = await seedNews("d");
    const { pageId } = await op<{ pageId: string }>(SYS, "pages.create", {
      slug: `${PFX}n4`,
      title: "N4",
      pageType: news.typeSlug,
      properties: { teaser: "keep me?" },
      terms: [news.catA],
    });
    const current = await op<{ pageType: { version: number } }>(SYS, "page_types.get", {
      slug: news.typeSlug,
    });
    const next = {
      slug: news.typeSlug,
      name: "News",
      purpose: "Dated news articles",
      collection: true,
      templates: [news.templateId],
      defaultTemplate: news.templateId,
      properties: [
        { name: "featured", label: "Featured", type: "boolean", default: false },
        { name: "reading_time", label: "Reading time", type: "number", default: 3 },
      ],
      vocabularies: [{ list: news.vocabId, cardinality: "one", required: true }],
      expectedVersion: current.pageType.version,
    };
    const refused = await fail(SYS, "page_types.upsert_many", { pageTypes: [next] });
    expect(refused).toContain('property "teaser"');
    expect(refused).toContain("dropValues");
    const ok = await op<{ pageTypes: { pagesRewritten: number }[] }>(
      SYS,
      "page_types.upsert_many",
      {
        pageTypes: [next],
        dropValues: true,
      },
    );
    expect(ok.pageTypes[0]?.pagesRewritten).toBe(1);
    expect((await page(SYS, pageId)).properties).toEqual({ featured: false, reading_time: 3 });
    // The type is used: it cannot be deleted.
    expect(await fail(SYS, "page_types.delete_many", { slugs: [news.typeSlug] })).toContain(
      "used by 1 page",
    );
  });

  it("templates.create joins a page type; list and get report it", async () => {
    const news = await seedNews("e");
    const { templateId } = await op<{ templateId: string }>(SYS, "templates.create", {
      slug: `${PFX}news-wide`,
      displayName: "News wide",
      html: '<main><caelo-slot name="content"></caelo-slot></main>',
      pageType: news.typeSlug,
    });
    const tpl = await op<{ template: { pageTypes: string[] } }>(SYS, "templates.get", {
      templateId,
    });
    expect(tpl.template.pageTypes).toEqual([news.typeSlug]);
    const bad = await fail(SYS, "templates.create", {
      slug: `${PFX}orphan`,
      displayName: "Orphan",
      html: "<main></main>",
      pageType: `${PFX}no-such-type`,
    });
    expect(bad).toContain("no page type");

    // #1177 / #1276 — the error names the call that works (the type and
    // its first template together), and following it works.
    expect(bad).toContain("newPageType");
    const viaTool = await createTemplateTool.handler(
      SYS,
      {
        slug: `${PFX}orphan`,
        displayName: "Orphan",
        html: "<main></main>",
        pageType: `${PFX}no-such-type`,
      },
      { registry, adapter } as unknown as ToolContext,
    );
    expect(viaTool.content).toContain("newPageType");
    expect(viaTool.content).toContain("upsert_page_types_many");
    expect(viaTool.content).not.toContain("page_types.upsert_many");
    const first = await op<{ templateId: string }>(SYS, "templates.create", {
      slug: `${PFX}article-tpl`,
      displayName: "Article",
      html: '<main><caelo-slot name="content"></caelo-slot></main>',
      newPageType: {
        slug: `${PFX}article`,
        name: "Article",
        purpose: "Long-form articles.",
        collection: true,
      },
    });
    const listed = await op<{ pageTypes: { slug: string; defaultTemplate: string }[] }>(
      SYS,
      "page_types.list",
      {},
    );
    expect(listed.pageTypes.find((t) => t.slug === `${PFX}article`)?.defaultTemplate).toBe(
      first.templateId,
    );
  });

  it("stamps first_published_at once, on the first production publish only", async () => {
    const news = await seedNews("f");
    const { pageId } = await op<{ pageId: string }>(SYS, "pages.create", {
      slug: `${PFX}n5`,
      title: "N5",
      pageType: news.typeSlug,
      terms: [news.catA],
      status: "published",
    });
    expect(
      (await op<{ page: { firstPublishedAt: string | null } }>(SYS, "pages.get", { pageId })).page
        .firstPublishedAt,
    ).toBeNull();
    const { stampFirstPublished } = await import("../ops/content/first-published.js");
    const runId = await asSystem(async (tx) => {
      const t = (await tx`
        INSERT INTO deploy_targets (name, env, out_dir) VALUES (${`${PFX}prod`}, 'production', '/tmp/x')
        RETURNING id::text AS id`) as { id: string }[];
      const r = (await tx`
        INSERT INTO deploy_runs (target_id, actor_id, status) VALUES (${t[0]?.id}::uuid, ${SYSTEM_ID}::uuid, 'running')
        RETURNING id::text AS id`) as { id: string }[];
      return r[0]?.id ?? "";
    });
    await adapter.admin.transaction(async (tx) => {
      await tx.execute(
        (await import("drizzle-orm")).sql`SELECT set_config('caelo.actor_kind', 'system', true)`,
      );
      await stampFirstPublished(tx, runId);
    });
    const first = (
      await op<{ page: { firstPublishedAt: string | null } }>(SYS, "pages.get", { pageId })
    ).page.firstPublishedAt;
    expect(first).not.toBeNull();
    // The stored value is the run's start: the instant the build rendered
    // for this never-live page (#1121 review), not the moment of stamping.
    const { deployRunStartedAt } = await import("../ops/content/first-published.js");
    const startedAt = await adapter.admin.transaction(async (tx) => {
      await tx.execute(
        (await import("drizzle-orm")).sql`SELECT set_config('caelo.actor_kind', 'system', true)`,
      );
      return deployRunStartedAt(tx, runId);
    });
    expect(new Date(first ?? "").toISOString()).toBe(startedAt);
    await adapter.admin.transaction(async (tx) => {
      await tx.execute(
        (await import("drizzle-orm")).sql`SELECT set_config('caelo.actor_kind', 'system', true)`,
      );
      await stampFirstPublished(tx, runId);
    });
    expect(
      (await op<{ page: { firstPublishedAt: string | null } }>(SYS, "pages.get", { pageId })).page
        .firstPublishedAt,
    ).toBe(first);
  });
});

describe("#1107 render-data loader", () => {
  it("loads the draft view for previews and the published state for builds", async () => {
    await asSystem((tx) => tx`UPDATE site_defaults SET site_language = 'en' WHERE id = 1`);
    const news = await seedNews("g");
    const { pageId } = await op<{ pageId: string }>(SYS, "pages.create", {
      slug: `${PFX}n6`,
      title: "N6",
      pageType: news.typeSlug,
      terms: [news.catA],
      status: "published",
    });
    const a = await chat("loader");
    await op(a.ctx, "lists.upsert_many", {
      lists: [
        {
          slug: `${PFX}draft-only`,
          name: "Draft",
          purpose: "x",
          type: "texts",
          items: [{ node: "text", values: { text: "hi" } }],
        },
      ],
    });
    await op(a.ctx, "pages.update", { pageId, properties: { teaser: "draft" } });

    const preview = await adapter.admin.transaction(async (tx) => {
      await tx.execute(
        (await import("drizzle-orm")).sql`SELECT set_config('caelo.actor_kind', 'system', true)`,
      );
      return loadListRenderData(tx, { chatBranchId: a.branch, scope: "preview", env: "preview" });
    });
    const build = await adapter.admin.transaction(async (tx) => {
      await tx.execute(
        (await import("drizzle-orm")).sql`SELECT set_config('caelo.actor_kind', 'system', true)`,
      );
      return loadListRenderData(tx, { chatBranchId: a.branch, scope: "build", env: "production" });
    });
    const draftSlugs = [...preview.lists.values()].map((l) => l.slug);
    expect(draftSlugs).toContain(`${PFX}draft-only`);
    expect([...build.lists.values()].map((l) => l.slug)).not.toContain(`${PFX}draft-only`);
    expect(preview.pages.get(pageId)).toMatchObject({
      pageTypeSlug: news.typeSlug,
      terms: [news.catA],
      inBuild: true,
      properties: { teaser: "draft" },
    });
    expect(build.pages.get(pageId)?.properties).not.toHaveProperty("teaser");
    // Never live yet, but published: it sorts into "latest news" as new,
    // not last (#1121 review).
    expect(preview.pages.get(pageId)?.firstPublishedAt).not.toBeNull();
    expect(preview.listTypes.get("menu")?.def.role).toBe("navigation");
    expect(preview.pageTypes.get(news.typeSlug)?.def.vocabularies[0]?.list).toBe(news.vocabId);
    expect(preview.siteLanguage).toBe("en");
  });
});
