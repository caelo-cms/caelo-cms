// SPDX-License-Identifier: MPL-2.0

/**
 * #1752 — the SEO head fields, end to end against a real database:
 *
 *   - title templates per page type and site-wide (`page_types.set_seo_many`),
 *     precedence site → page type → page, each value with its origin in
 *     `pages_seo.get` / `get_many`;
 *   - who wrote a text (`human` / `ai`), and `reviewed` (a person only);
 *   - fill-once for the new texts: autofill fills empty ones before the
 *     page was ever live, never overwrites, the same text again is a no-op;
 *   - the robots directives in one `<meta name="robots">`, the sitemap
 *     leaving out exactly the noindex pages;
 *   - `data-nosnippet` on a placement, kept across a move of the module;
 *   - preview == build head, an article dated from the live record;
 *   - a chat's SEO title is draft state, live with the merge;
 *   - a translation fills the new texts once and keeps a live one;
 *   - a page type replacement keeps the type's SEO.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBuildPluginServices, resetPluginHost } from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { bodyContentDigest, pageContentFingerprint } from "@caelo-cms/static-generator";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { runSeoPass } from "./fixtures/seo-pass.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const ACTOR = "00000000-0000-0000-0000-00000000ffff";
const PFX = "t1752-";
const BASE = "https://example.com";
const SYS: ExecutionContext = { actorId: ACTOR, actorKind: "system", requestId: "t1752" };
const HUMAN: ExecutionContext = { actorId: ACTOR, actorKind: "human", requestId: "t1752-h" };
const AI: ExecutionContext = { actorId: ACTOR, actorKind: "ai", requestId: "t1752-ai" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
let buildDir = "";
const restores: (() => Promise<void>)[] = [];

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
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

async function refused(ctx: ExecutionContext, name: string, input: unknown): Promise<string> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (r.ok) throw new Error(`${name} succeeded, expected a refusal`);
  return JSON.stringify(r.error);
}

async function page(slug: string, pageType = "home", status = "published"): Promise<string> {
  return (
    await op<{ pageId: string }>(SYS, "pages.create", {
      slug: `${PFX}${slug}`,
      title: `Title ${slug}`,
      shortTitle: `Short ${slug}`,
      pageType,
      templateId,
      status,
    })
  ).pageId;
}

interface Resolved {
  title: { value: string; origin: string; template: string | null };
  metaDescription: { value: string; origin: string };
  ogTitle: { value: string; origin: string; inheritsFrom: string | null };
  ogDescription: { value: string; origin: string; inheritsFrom: string | null };
  ogType: { value: string; origin: string };
  robots: string;
  pageType: string;
  unsetVariables: string[];
}

interface SeoRow {
  seoTitle: string;
  metaDescription: string;
  ogTitle: string;
  origins: Record<string, string>;
  nosnippetPlacements: { blockName: string; position: number }[];
  pendingFields: string[];
}

async function read(
  ctx: ExecutionContext,
  pageId: string,
): Promise<{ seo: SeoRow | null; resolved: Resolved }> {
  const v = await op<{ seo: SeoRow | null; resolved: Resolved | null }>(ctx, "pages_seo.get", {
    pageId,
  });
  if (!v.resolved) throw new Error(`no resolved head for ${pageId}`);
  return { seo: v.seo, resolved: v.resolved };
}

async function wipe(): Promise<void> {
  resetPluginHost();
  await withSql(async (tx) => {
    await tx`DELETE FROM deploy_runs WHERE id IN (SELECT run_id FROM live_page_versions WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`}))`;
    await tx`DELETE FROM pages_seo WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM page_types WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${`${PFX}tpl`})`;
    await tx`DELETE FROM templates WHERE slug = ${`${PFX}tpl`}`;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipe();
  buildDir = mkdtempSync(join(tmpdir(), "t1752-build-"));
  restores.push(await pinSiteBaseUrl(ADMIN_URL, BASE));
  restores.push(await pinSiteLanguage(ADMIN_URL, "en"));
  const before = await withSql(
    (tx) =>
      tx`SELECT site_name, seo_title_template FROM site_defaults WHERE id = 1` as unknown as Promise<
        { site_name: string | null; seo_title_template: string }[]
      >,
  );
  restores.push(() =>
    withSql(async (tx) => {
      await tx`UPDATE site_defaults SET site_name = ${before[0]?.site_name ?? null},
               seo_title_template = ${before[0]?.seo_title_template ?? "{page_title}"} WHERE id = 1`;
    }),
  );
  await withSql(async (tx) => {
    await tx`UPDATE site_defaults SET site_name = 'Acme', seo_title_template = '{page_title}' WHERE id = 1`;
  });
  templateId = (
    await op<{ templateId: string }>(SYS, "templates.create", {
      pageType: "home",
      slug: `${PFX}tpl`,
      displayName: "SEO head fields",
      html: `<html><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
      css: "",
    })
  ).templateId;
  await op(SYS, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  await op(SYS, "page_types.upsert_many", {
    pageTypes: [
      {
        slug: `${PFX}news`,
        name: "News",
        purpose: "Dated news posts.",
        collection: true,
        templates: [templateId],
        defaultTemplate: templateId,
      },
    ],
  });
});

afterAll(async () => {
  await wipe();
  for (const r of restores.reverse()) await r();
  rmSync(buildDir, { recursive: true, force: true });
  await adapter.close();
});

describe("#1752 title templates and origins", () => {
  it("resolves site → page type → page, each value with its origin", async () => {
    const p = await page("post", `${PFX}news`);
    const site = await read(SYS, p);
    expect(site.resolved.title).toEqual({
      value: "Title post",
      origin: "site",
      template: "{page_title}",
    });
    expect(site.resolved.ogTitle).toMatchObject({ value: "Title post", origin: "inherited" });
    expect(site.resolved.ogType).toEqual({ value: "website", origin: "site" });
    expect(site.resolved.robots).toBe("max-image-preview:large");

    const set = await op<{
      siteTitleTemplate: { changed: boolean };
      pageTypes: { changed: boolean }[];
    }>(HUMAN, "page_types.set_seo_many", {
      siteTitleTemplate: "{page_title} | {site_name}",
      pageTypes: [
        {
          pageType: `${PFX}news`,
          titleTemplate: "{short_title} – News | {site_name}",
          ogType: "article",
        },
      ],
    });
    expect(set.siteTitleTemplate.changed).toBe(true);
    expect(set.pageTypes[0]?.changed).toBe(true);
    const typed = await read(SYS, p);
    expect(typed.resolved.title).toEqual({
      value: "Short post – News | Acme",
      origin: "page_type",
      template: "{short_title} – News | {site_name}",
    });
    expect(typed.resolved.ogType).toEqual({ value: "article", origin: "page_type" });
    // A page of a type without a template gets the site's.
    const home = await page("home-like");
    expect((await read(SYS, home)).resolved.title).toMatchObject({
      value: "Title home-like | Acme",
      origin: "site",
    });

    await op(AI, "pages_seo.set", { pageId: p, seoTitle: "Our launch, explained" });
    const own = await read(SYS, p);
    expect(own.resolved.title).toEqual({
      value: "Our launch, explained",
      origin: "ai",
      template: null,
    });
    expect(own.resolved.ogTitle).toEqual({
      value: "Our launch, explained",
      origin: "inherited",
      inheritsFrom: "seoTitle",
    });

    // Only a person marks an AI text reviewed.
    expect(await refused(AI, "pages_seo.set", { pageId: p, reviewed: ["seoTitle"] })).toContain(
      "only a person",
    );
    await op(HUMAN, "pages_seo.set", { pageId: p, reviewed: ["seoTitle"] });
    expect((await read(SYS, p)).seo?.origins.seoTitle).toBe("reviewed");
    // A person's edit makes the text theirs.
    await op(HUMAN, "pages_seo.set", { pageId: p, seoTitle: "Launch week" });
    expect((await read(SYS, p)).resolved.title).toMatchObject({
      value: "Launch week",
      origin: "human",
    });
    // "" hands the title back to the template.
    await op(HUMAN, "pages_seo.set", { pageId: p, seoTitle: "" });
    expect((await read(SYS, p)).resolved.title.origin).toBe("page_type");
    expect((await read(SYS, p)).seo?.origins.seoTitle).toBeUndefined();

    // null clears the type's own values: the site's apply again.
    await op(HUMAN, "page_types.set_seo_many", {
      pageTypes: [{ pageType: `${PFX}news`, titleTemplate: null, ogType: null }],
    });
    expect((await read(SYS, p)).resolved.title).toMatchObject({
      value: "Title post | Acme",
      origin: "site",
    });
    await op(HUMAN, "page_types.set_seo_many", { siteTitleTemplate: "{page_title}" });
  });

  it("refuses an invalid template and {site_name} before the site has a name", async () => {
    expect(
      await refused(HUMAN, "page_types.set_seo_many", { siteTitleTemplate: "Acme" }),
    ).toContain("{page_title} or {short_title}");
    await withSql(async (tx) => {
      await tx`UPDATE site_defaults SET site_name = NULL WHERE id = 1`;
    });
    try {
      expect(
        await refused(HUMAN, "page_types.set_seo_many", {
          siteTitleTemplate: "{page_title} | {site_name}",
        }),
      ).toContain("set_site_identity");
    } finally {
      await withSql(async (tx) => {
        await tx`UPDATE site_defaults SET site_name = 'Acme' WHERE id = 1`;
      });
    }
  });

  it("a page type replacement keeps the type's SEO", async () => {
    await op(HUMAN, "page_types.set_seo_many", {
      pageTypes: [{ pageType: `${PFX}news`, ogType: "article" }],
    });
    await op(SYS, "page_types.upsert_many", {
      pageTypes: [
        {
          slug: `${PFX}news`,
          name: "News",
          purpose: "Dated news posts, now with a longer purpose.",
          collection: true,
          templates: [templateId],
          defaultTemplate: templateId,
        },
      ],
    });
    const types = await op<{ pageTypes: { slug: string; seo?: { ogType?: string } }[] }>(
      SYS,
      "page_types.list",
      {},
    );
    expect(types.pageTypes.find((t) => t.slug === `${PFX}news`)?.seo).toEqual({
      ogType: "article",
    });
  });

  it("builds on another chat's pending page type edit it takes over (review #1771)", async () => {
    const experiment = async (title: string): Promise<ExecutionContext> => {
      const v = await op<{ chatSessionId: string; chatBranchId: string }>(
        SYS,
        "chat.create_session",
        { title: `${PFX}${title}`, isolation: "experiment" },
      );
      return { ...AI, chatBranchId: v.chatBranchId, chatTaskId: v.chatSessionId };
    };
    const a = await experiment("type-a");
    const b = await experiment("type-b");
    const def = {
      slug: `${PFX}news`,
      name: "News",
      collection: true,
      templates: [templateId],
      defaultTemplate: templateId,
    };
    await op(a, "page_types.upsert_many", {
      pageTypes: [{ ...def, purpose: "Purpose written in chat A." }],
    });
    await op(b, "page_types.set_seo_many", {
      pageTypes: [{ pageType: `${PFX}news`, ogType: "profile" }],
    });
    const seen = await op<{ pageType: { purpose: string; seo?: { ogType?: string } } }>(
      b,
      "page_types.get",
      { slug: `${PFX}news` },
    );
    expect(seen.pageType.purpose).toBe("Purpose written in chat A.");
    expect(seen.pageType.seo?.ogType).toBe("profile");
  });

  it("a replacement that takes over another chat's pending SEO keeps it (review #1771)", async () => {
    const experiment = async (title: string): Promise<ExecutionContext> => {
      const v = await op<{ chatSessionId: string; chatBranchId: string }>(
        SYS,
        "chat.create_session",
        { title: `${PFX}${title}`, isolation: "experiment" },
      );
      return { ...AI, chatBranchId: v.chatBranchId, chatTaskId: v.chatSessionId };
    };
    const a = await experiment("seo-a");
    const b = await experiment("seo-b");
    await op(a, "page_types.set_seo_many", {
      pageTypes: [{ pageType: `${PFX}news`, titleTemplate: "{page_title} – from chat A" }],
    });
    await op(b, "page_types.upsert_many", {
      pageTypes: [
        {
          slug: `${PFX}news`,
          name: "News",
          purpose: "Purpose written in chat B.",
          collection: true,
          templates: [templateId],
          defaultTemplate: templateId,
        },
      ],
    });
    const seen = await op<{ pageType: { purpose: string; seo?: { titleTemplate?: string } } }>(
      b,
      "page_types.get",
      { slug: `${PFX}news` },
    );
    expect(seen.pageType.purpose).toBe("Purpose written in chat B.");
    expect(seen.pageType.seo?.titleTemplate).toBe("{page_title} – from chat A");
  });

  it("a chat's SEO title is draft state, live with the merge", async () => {
    const p = await page("drafted");
    const v = await op<{ chatSessionId: string; chatBranchId: string }>(
      SYS,
      "chat.create_session",
      {
        title: `${PFX}chat`,
      },
    );
    const chat: ExecutionContext = {
      ...AI,
      chatBranchId: v.chatBranchId,
      chatTaskId: v.chatSessionId,
    };
    await op(chat, "pages_seo.set", { pageId: p, seoTitle: "Drafted title", nofollow: true });
    expect((await read(chat, p)).seo).toMatchObject({
      seoTitle: "Drafted title",
      pendingFields: ["seoTitle", "nofollow"],
    });
    expect((await read(SYS, p)).resolved.title.value).toBe("Title drafted");
    await op(SYS, "chat.merge_draft_to_main", { chatSessionIds: [v.chatSessionId] });
    const live = await read(SYS, p);
    expect(live.resolved.title).toMatchObject({ value: "Drafted title", origin: "ai" });
    expect(live.resolved.robots).toBe("nofollow, max-image-preview:large");
  });
});

describe("#1752 fill-once for the new texts", () => {
  it("fills empty texts once, never overwrites, and not on a page already live", async () => {
    const p = await page("fill", "home", "draft");
    await op(AI, "pages_seo.autofill", {
      pageId: p,
      metaDescription: "First description.",
      seoTitle: "First SEO title",
    });
    const first = await read(SYS, p);
    expect(first.seo).toMatchObject({
      seoTitle: "First SEO title",
      metaDescription: "First description.",
    });
    expect(first.seo?.origins).toEqual({ seoTitle: "ai", metaDescription: "ai" });

    // The same texts again: a no-op.
    expect(
      await op<{ alreadyFilled: boolean }>(AI, "pages_seo.autofill", {
        pageId: p,
        metaDescription: "First description.",
        seoTitle: "First SEO title",
      }),
    ).toEqual({ alreadyFilled: true });
    // A different SEO title is refused, and nothing changes.
    expect(
      await refused(AI, "pages_seo.autofill", {
        pageId: p,
        metaDescription: "First description.",
        seoTitle: "Another title",
      }),
    ).toContain("AlreadyFilled");
    // A still-empty og:title is filled later (the description repeats).
    await op(AI, "pages_seo.autofill", {
      pageId: p,
      metaDescription: "First description.",
      ogTitle: "Share title",
    });
    expect((await read(SYS, p)).seo).toMatchObject({
      seoTitle: "First SEO title",
      ogTitle: "Share title",
    });

    // A page that was published live: an empty SEO title is no gap.
    const live = await page("fill-live");
    await withSql(async (tx) => {
      await tx`UPDATE pages SET first_published_at = now() WHERE id = ${live}::uuid`;
    });
    expect(
      await refused(AI, "pages_seo.autofill", {
        pageId: live,
        metaDescription: "Live description.",
        seoTitle: "Not on a live page",
      }),
    ).toContain("is live");
    expect((await read(SYS, live)).seo).toBeNull();
  });

  it("a translation fills the texts once and keeps a live page's own", async () => {
    const draft = await page("tr-draft", "home", "draft");
    const filled = await op<{ outcome: string; fields: Record<string, string> }>(
      SYS,
      "pages_seo.apply_translation",
      { pageId: draft, seoTitle: "Übersetzter Titel", ogDescription: "Teilen" },
    );
    expect(filled).toEqual({
      outcome: "filled",
      fields: { seoTitle: "filled", ogDescription: "filled" },
    });
    // A translated title alone leaves the first description to autofill.
    const titled = await page("tr-title", "home", "draft");
    await op(SYS, "pages_seo.apply_translation", { pageId: titled, seoTitle: "Nur der Titel" });
    expect(
      await op<{ alreadyFilled: boolean }>(AI, "pages_seo.autofill", {
        pageId: titled,
        metaDescription: "Die erste Beschreibung.",
      }),
    ).toEqual({ alreadyFilled: false });

    const live = await page("tr-live");
    await op(HUMAN, "pages_seo.set", { pageId: live, seoTitle: "Kept title" });
    const kept = await op<{ outcome: string; fields: Record<string, string> }>(
      SYS,
      "pages_seo.apply_translation",
      { pageId: live, seoTitle: "Overwrite?", metaDescription: "New description" },
    );
    expect(kept).toEqual({
      outcome: "marked_stale",
      fields: { seoTitle: "marked_stale", metaDescription: "filled" },
    });
    expect((await read(SYS, live)).seo).toMatchObject({
      seoTitle: "Kept title",
      metaDescription: "New description",
    });
  });
});

describe("#1752 robots, data-nosnippet and preview == build", () => {
  it("renders one robots meta and leaves only noindex pages out of the sitemap", async () => {
    const followed = await page("nofollow");
    const hidden = await page("noindex");
    await op(HUMAN, "pages_seo.set_many", {
      items: [
        { pageId: followed, nofollow: true, maxSnippet: 80, noarchive: true },
        { pageId: hidden, noindex: true },
      ],
    });
    const pages = [
      {
        pageId: followed,
        pageSlug: `${PFX}nofollow`,
        html: "<html><head></head><body>a</body></html>",
      },
      {
        pageId: hidden,
        pageSlug: `${PFX}noindex`,
        html: "<html><head></head><body>b</body></html>",
      },
    ];
    await adapter.withAdminTransaction(SYS, async (tx) => {
      await runSeoPass({
        tx,
        plugins: localBuildPluginServices,
        buildDir,
        mediaRoot: buildDir,
        pages,
        settings: { siteBaseUrl: BASE, sitemapEnabled: true, siteLanguage: "en", organization: {} },
        pageUrlStyle: "directory",
        notFoundPageId: null,
      });
    });
    expect(pages[0]?.html.match(/<meta name="robots"[^>]*>/g)).toEqual([
      '<meta name="robots" content="nofollow, noarchive, max-snippet:80, max-image-preview:large" />',
    ]);
    expect(pages[1]?.html).toContain(
      '<meta name="robots" content="noindex, max-image-preview:large" />',
    );
    const sitemap = readFileSync(join(buildDir, "sitemap.xml"), "utf8");
    expect(sitemap).toContain(`${PFX}nofollow`);
    expect(sitemap).not.toContain(`${PFX}noindex`);
  });

  it("marks a placement data-nosnippet, by its content, in the preview", async () => {
    const p = await page("nosnippet");
    const moduleId = (
      await op<{ moduleId: string }>(SYS, "modules.create", {
        slug: `${PFX}quote`,
        displayName: "Quote",
        html: "<article><p>Price list</p></article>",
        css: "",
        js: "",
      })
    ).moduleId;
    await op(SYS, "pages.set_modules", {
      pageId: p,
      blocks: [{ blockName: "content", moduleIds: [moduleId, moduleId] }],
    });
    expect(
      await refused(HUMAN, "pages_seo.set", {
        pageId: p,
        nosnippetPlacements: [{ blockName: "content", position: 5 }],
      }),
    ).toContain("content#0, content#1");
    await op(HUMAN, "pages_seo.set", {
      pageId: p,
      nosnippetPlacements: [{ blockName: "content", position: 1 }],
    });
    expect((await read(SYS, p)).seo?.nosnippetPlacements).toEqual([
      { blockName: "content", position: 1 },
    ]);
    const preview = await op<{ html: string }>(SYS, "pages.render_preview", { pageId: p });
    expect(preview.html.match(/data-nosnippet/g)).toHaveLength(1);
    expect(preview.html).toContain('<div data-nosnippet=""><article');
  });

  it("resolves data-nosnippet placements again against a layout it takes over (review #1771)", async () => {
    const p = await page("nosnippet-takeover");
    const mod = async (slug: string, html: string) =>
      (
        await op<{ moduleId: string }>(SYS, "modules.create", {
          slug: `${PFX}${slug}`,
          displayName: slug,
          html,
          css: "",
          js: "",
        })
      ).moduleId;
    const before = await mod("before", "<div><p>Old block</p></div>");
    const after = await mod("after", "<div><p>Replaced block</p></div>");
    await op(SYS, "pages.set_modules", {
      pageId: p,
      blocks: [{ blockName: "content", moduleIds: [before] }],
    });
    const experiment = async (title: string): Promise<ExecutionContext> => {
      const v = await op<{ chatSessionId: string; chatBranchId: string }>(
        SYS,
        "chat.create_session",
        { title: `${PFX}${title}`, isolation: "experiment" },
      );
      return { ...AI, chatBranchId: v.chatBranchId, chatTaskId: v.chatSessionId };
    };
    const a = await experiment("layout-a");
    const b = await experiment("layout-b");
    // Chat A replaces the placement; chat B then marks content#0.
    await op(a, "pages.set_modules", {
      pageId: p,
      blocks: [{ blockName: "content", moduleIds: [after] }],
    });
    await op(HUMAN, "pages_seo.set", { pageId: p, metaDescription: "Live description." });
    await op(b, "pages_seo.set", {
      pageId: p,
      nosnippetPlacements: [{ blockName: "content", position: 0 }],
    });
    expect((await read(b, p)).seo?.nosnippetPlacements).toEqual([
      { blockName: "content", position: 0 },
    ]);
    const preview = (await op<{ html: string }>(b, "pages.render_preview", { pageId: p })).html;
    expect(preview).toMatch(
      /<div data-caelo-module-id="[^"]+" data-nosnippet=""><p>Replaced block/,
    );
  });

  it("the preview renders the build's head, an article dated from the live record", async () => {
    await op(HUMAN, "page_types.set_seo_many", {
      pageTypes: [
        { pageType: `${PFX}news`, titleTemplate: "{page_title} · News", ogType: "article" },
      ],
    });
    const p = await page("article", `${PFX}news`);
    await op(HUMAN, "pages_seo.set", {
      pageId: p,
      metaDescription: "What happened.",
      ogTitle: "Read this",
      maxImagePreview: "standard",
    });
    const published = "2026-01-02T03:04:05.000Z";
    const changed = "2026-02-03T04:05:06.000Z";
    const body = "<html><head></head><body>article body</body></html>";
    // The page is live, unchanged since the record dated it.
    await withSql(async (tx) => {
      await tx`UPDATE pages SET first_published_at = ${published}::timestamptz WHERE id = ${p}::uuid`;
      const run = (await tx`
        INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at)
        SELECT id, ${ACTOR}::uuid, 'succeeded', now(), now() FROM deploy_targets WHERE name = 'production'
        RETURNING id::text AS id`) as { id: string }[];
      await tx`
        INSERT INTO live_page_versions (run_id, page_id, kind, url, fingerprint, title, summary, changed_at)
        VALUES (${run[0]?.id}::uuid, ${p}::uuid, 'added', ${`${BASE}/${PFX}article/`},
                ${pageContentFingerprint({
                  title: "Title article",
                  headTitle: "Title article · News",
                  metaDescription: "What happened.",
                  bodyDigest: bodyContentDigest(body),
                })},
                'Title article', 'What happened.', ${changed}::timestamptz)`;
    });

    const preview = (await op<{ html: string }>(SYS, "pages.render_preview", { pageId: p })).html;
    const built = { pageId: p, pageSlug: `${PFX}article`, html: body };
    await adapter.withAdminTransaction(SYS, async (tx) => {
      await runSeoPass({
        tx,
        plugins: localBuildPluginServices,
        buildDir,
        mediaRoot: buildDir,
        pages: [built],
        settings: {
          siteBaseUrl: BASE,
          sitemapEnabled: false,
          siteLanguage: "en",
          organization: {},
          siteName: "Acme",
          titleTemplate: "{page_title}",
        },
        pageUrlStyle: "directory",
        notFoundPageId: null,
      });
    });
    const headTags = (html: string): string[] =>
      [
        ...html.matchAll(
          /<title>[^<]*<\/title>|<meta (?:name="robots"|name="description"|property="(?:og|article):[a-z_:]+")[^>]*>/g,
        ),
      ].map((m) => m[0]);
    const expected = [
      "<title>Title article · News</title>",
      '<meta name="description" content="What happened." />',
      '<meta name="robots" content="max-image-preview:standard" />',
      '<meta property="og:title" content="Read this" />',
      '<meta property="og:description" content="What happened." />',
      '<meta property="og:type" content="article" />',
      `<meta property="og:url" content="${BASE}/${PFX}article/" />`,
      '<meta property="og:site_name" content="Acme" />',
      `<meta property="article:published_time" content="${published}" />`,
      `<meta property="article:modified_time" content="${changed}" />`,
    ];
    expect(headTags(built.html)).toEqual(expected);
    expect(headTags(preview)).toEqual(expected);
  });
});
