// SPDX-License-Identifier: MPL-2.0

/**
 * #1142 — breadcrumbs end to end through the real ops: a module whose
 * `list` field binds the `breadcrumbs` system source renders the trail
 * home → … → current with each page's short title, takes its aria-label
 * from the site texts, and the page carries a `BreadcrumbList` JSON-LD
 * that is byte-identical in the editor preview and the generator's SEO
 * pass. A move and a short-title edit reach the trail without touching
 * the module.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBuildPluginServices, resetPluginHost } from "@caelo-cms/plugin-host";
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

const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t1142",
};
const BASE = "https://example.com";
const LABEL_ITEM = "00000000-0000-4000-9000-000000001142";

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let restoreBaseUrl: (() => Promise<void>) | null = null;
let restoreLanguage: (() => Promise<void>) | null = null;
let previousHome: string | null = null;
let buildDir = "";
const ids = { home: "", about: "", team: "" };

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

async function run<T>(op: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYS, op, input);
  if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function cleanup(): Promise<void> {
  await sqlSystem(async (tx) => {
    await tx.unsafe("DELETE FROM pages WHERE slug LIKE 't1142-%'");
    await tx.unsafe("DELETE FROM templates WHERE slug LIKE 't1142-%'");
  });
}

async function preview(pageId: string): Promise<string> {
  return (await run<{ html: string }>("pages.render_preview", { pageId })).html;
}

const nav = (html: string): string => /<nav[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
const crumbsLd = (html: string): string | null =>
  [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)]
    .map((m) => m[1] as string)
    .find((s) => s.includes('"BreadcrumbList"')) ?? null;
const crumbLabels = (html: string): string[] =>
  [...nav(html).matchAll(/<li[^>]*>(?:<a [^>]*>|<span [^>]*>)([^<]*)</g)].map(
    (m) => m[1] as string,
  );

beforeAll(async () => {
  resetPluginHost();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  buildDir = mkdtempSync(join(tmpdir(), "t1142-build-"));
  restoreBaseUrl = await pinSiteBaseUrl(ADMIN_URL, BASE);
  restoreLanguage = await pinSiteLanguage(ADMIN_URL, "de");
  previousHome = await sqlSystem(async (tx) => {
    const rows = await tx`SELECT home_page_id::text AS id FROM site_defaults WHERE id = 1`;
    return (rows[0] as { id: string | null } | undefined)?.id ?? null;
  });

  const tpl = await run<{ templateId: string }>("templates.create", {
    slug: "t1142-tpl",
    displayName: "T1142",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  await run("template_blocks.set", {
    templateId: tpl.templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const create = async (slug: string, title: string, extra: Record<string, unknown> = {}) =>
    (
      await run<{ pageId: string }>("pages.create", {
        slug,
        title,
        templateId: tpl.templateId,
        status: "published",
        ...extra,
      })
    ).pageId;
  ids.home = await create("t1142-home", "Welcome to the example site", { shortTitle: "Start" });
  ids.about = await create("t1142-about", "About the example company", { shortTitle: "About" });
  ids.team = await create("t1142-team", "Team", { parentPageId: ids.about });
  await run("pages.set_home_page", { pageId: ids.home });

  await run("lists.patch_items_many", {
    lists: [
      {
        slug: "site-texts",
        patches: [
          {
            op: "add",
            item: {
              id: LABEL_ITEM,
              node: "text",
              values: { key: "breadcrumb_label", text: "Brotkrumen" },
            },
          },
        ],
      },
    ],
  });

  await run("pages.build_page", {
    page: { pageId: ids.team },
    modules: [
      {
        blockName: "content",
        displayName: "T1142 breadcrumbs",
        description: "The breadcrumb trail of the page.",
        kind: "utility",
        html: '<nav aria-label="{{site_text.breadcrumb_label}}"><ol>{{#crumbs}}<li>{{#is_current}}<span aria-current="page">{{short_title}}</span>{{/is_current}}{{^is_current}}<a href="{{link}}">{{short_title}}</a>{{/is_current}}</li>{{/crumbs}}</ol></nav>',
        fields: [
          {
            name: "crumbs",
            kind: "list",
            label: "Breadcrumbs",
            listType: "links",
            bind: "source",
            source: { kind: "system", name: "breadcrumbs" },
          },
        ],
        content: { source: "inline", values: {} },
      },
    ],
  });
});

afterAll(async () => {
  // Site-wide settings first, each in its own finally: a failed seed or
  // cleanup must never leave the shared test database pinned to this
  // file's base URL, language or home page.
  try {
    await run("lists.patch_items_many", {
      lists: [{ slug: "site-texts", patches: [{ op: "remove", itemId: LABEL_ITEM }] }],
    }).catch(() => undefined);
    await cleanup();
  } finally {
    try {
      await sqlSystem(async (tx) => {
        await tx`UPDATE site_defaults SET home_page_id = ${previousHome}::uuid WHERE id = 1`;
      });
    } finally {
      try {
        await restoreBaseUrl?.();
        await restoreLanguage?.();
      } finally {
        rmSync(buildDir, { recursive: true, force: true });
        await adapter.close();
      }
    }
  }
});

describe("#1142 breadcrumbs", () => {
  it("renders home → parent → current with short titles and the site text aria-label", async () => {
    const html = await preview(ids.team);
    expect(nav(html)).toContain('aria-label="Brotkrumen"');
    expect(crumbLabels(html)).toEqual(["Start", "About", "Team"]);
    expect(nav(html)).toContain('<span aria-current="page">Team</span>');
  });

  it("emits the same BreadcrumbList JSON-LD in the preview and the generator", async () => {
    const previewLd = crumbsLd(await preview(ids.team));
    expect(previewLd).not.toBeNull();
    expect(JSON.parse(previewLd as string)).toEqual({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Start", item: `${BASE}/` },
        { "@type": "ListItem", position: 2, name: "About", item: `${BASE}/t1142-about/` },
        { "@type": "ListItem", position: 3, name: "Team", item: `${BASE}/t1142-about/t1142-team/` },
      ],
    });

    // The generator re-renders only this page (an incremental build): the
    // trail's other pages come from the database, not from its bundles.
    const page = {
      pageId: ids.team,
      pageSlug: "t1142-team",
      pageTitle: "Team",
      html: "<html><head><title>x</title></head><body>b</body></html>",
      breadcrumbTrail: [ids.home, ids.about, ids.team],
    };
    await adapter.withAdminTransaction(SYS, async (tx) => {
      await runSeoPass({
        tx,
        plugins: localBuildPluginServices,
        buildDir,
        mediaRoot: buildDir,
        pages: [page],
        settings: {
          siteBaseUrl: BASE,
          sitemapEnabled: false,
          siteLanguage: "de",
          organization: {},
        },
        pageUrlStyle: "directory",
        notFoundPageId: null,
      });
    });
    expect(crumbsLd(page.html)).toBe(previewLd);
  });

  it("a page without a breadcrumb module carries no BreadcrumbList", async () => {
    expect(crumbsLd(await preview(ids.about))).toBeNull();
  });

  it("a short-title edit and a move reach the trail without touching the module", async () => {
    await run("pages.update", { pageId: ids.about, shortTitle: "Über uns" });
    expect(crumbLabels(await preview(ids.team))).toEqual(["Start", "Über uns", "Team"]);

    await run("pages.move_many", { moves: [{ pageId: ids.team, parentPageId: null }] });
    const html = await preview(ids.team);
    expect(crumbLabels(html)).toEqual(["Start", "Team"]);
    const ld = JSON.parse(crumbsLd(html) as string) as { itemListElement: { item: string }[] };
    expect(ld.itemListElement.map((i) => i.item)).toEqual([`${BASE}/`, `${BASE}/t1142-team/`]);
  });

  // Codex review on #1168: a page created from a long title stores that
  // title as its short title; saving its settings (which always submit
  // the short title) must still validate.
  it("a page whose short title was defaulted from a long title stays editable", async () => {
    const longTitle = `${"Pricing for teams of every size and every budget ".repeat(4)}`.trim();
    const created = await run<{ pageId: string }>("pages.create", {
      slug: "t1142-long",
      title: longTitle,
    });
    const page = await run<{ page: { shortTitle: string } }>("pages.get", {
      pageId: created.pageId,
    });
    expect(page.page.shortTitle).toBe(longTitle);
    await run("pages.update", {
      pageId: created.pageId,
      title: longTitle,
      shortTitle: page.page.shortTitle,
      status: "draft",
    });
  });

  it("duplicating with a new title gives the copy that title as its short title", async () => {
    const copy = await run<{ pageId: string }>("pages.duplicate", {
      sourcePageId: ids.about,
      newSlug: "t1142-about-copy",
      newTitle: "Careers",
    });
    const got = await run<{ page: { shortTitle: string } }>("pages.get", { pageId: copy.pageId });
    expect(got.page.shortTitle).toBe("Careers");
    const kept = await run<{ pageId: string }>("pages.duplicate", {
      sourcePageId: ids.about,
      newSlug: "t1142-about-copy2",
    });
    const keptPage = await run<{ page: { shortTitle: string } }>("pages.get", {
      pageId: kept.pageId,
    });
    expect(keptPage.page.shortTitle).toBe("Über uns");
  });
});
