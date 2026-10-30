// SPDX-License-Identifier: MPL-2.0

/**
 * #1257 — paginated overviews end to end through the real ops: a guides
 * hub with 55 child pages and a module whose `list` field paginates a
 * page query (20 per page) with a pager ABOVE the list. The editor
 * preview serves `/hub/page/<n>`; the static build emits every follow-up
 * page self-canonical, lists the indexable ones in the sitemap and in the
 * routing manifest; `follow_ups: "noindex"` on the placement keeps them
 * out of search; a page split over several pages without a pager is
 * refused; a list cut at the query cap of 50 is reported.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBuildPluginServices, resetPluginHost } from "@caelo-cms/plugin-host";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { generateSite } from "@caelo-cms/static-generator";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "t1257",
};
const BASE = "https://example.com";
const GUIDES = 55;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let restoreBaseUrl: (() => Promise<void>) | null = null;
let restoreLanguage: (() => Promise<void>) | null = null;
let root = "";
let templateId = "";
const ids = { hub: "", overviewInstance: "", capped: "", noPager: "" };

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
    await tx.unsafe(
      "DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE 't1257-%')",
    );
    await tx.unsafe("UPDATE pages SET parent_page_id = NULL WHERE slug LIKE 't1257-%'");
    await tx.unsafe("DELETE FROM pages WHERE slug LIKE 't1257-%'");
    await tx.unsafe("DELETE FROM templates WHERE slug LIKE 't1257-%'");
  });
}

const hubRef = (): string => `caelo:page/${ids.hub}`;
const guidesQuery = () => ({
  kind: "query",
  editable: [],
  defaults: { parent: hubRef(), order: "title_asc" },
});
const PAGER_FIELD = {
  name: "pager",
  kind: "list",
  label: "Pages",
  listType: "links",
  bind: "source",
  source: { kind: "system", name: "pagination" },
};
const PAGER_HTML =
  '<nav class="pager">{{#pager}}{{#is_prev}}<a rel="prev" href="{{link}}">prev</a>{{/is_prev}}{{/pager}}' +
  '{{#pager}}{{#is_current}}<span aria-current="page">{{number}}</span>{{/is_current}}{{^is_current}}<a href="{{link}}">{{number}}</a>{{/is_current}}{{/pager}}' +
  '{{#pager}}{{#is_next}}<a rel="next" href="{{link}}">next</a>{{/is_next}}{{/pager}}</nav>';

async function createPage(slug: string, title: string, parentPageId?: string): Promise<string> {
  return (
    await run<{ pageId: string }>("pages.create", {
      slug,
      title,
      templateId,
      status: "published",
      ...(parentPageId ? { parentPageId } : {}),
    })
  ).pageId;
}

async function build(runId: string, changedPageIds?: string[]) {
  return adapter.withAdminTransaction(SYS, (tx) =>
    generateSite({
      publishAt: new Date().toISOString(),
      tx,
      plugins: localBuildPluginServices,
      target: {
        id: "00000000-0000-0000-0000-0000000012a7",
        name: "dev",
        env: "dev",
        outDir: "out",
        baseUrl: BASE,
        robotsDefault: "noindex",
      },
      runId,
      repoRoot: root,
      ...(changedPageIds ? { changedPageIds } : {}),
    }),
  );
}

const fileOf = (runId: string, rel: string) => join(root, "out", "builds", runId, rel);
const read = (runId: string, rel: string) => readFile(fileOf(runId, rel), "utf8");
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const titles = (html: string): string[] =>
  [...html.matchAll(/<li>(T1257 Guide \d+)<\/li>/g)].map((m) => m[1] as string);
const canonicalOf = (html: string): string | null =>
  /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1] ?? null;
const noindex = (html: string): boolean => /<meta name="robots" content="noindex"/.test(html);
const guide = (n: number) => `T1257 Guide ${String(n).padStart(2, "0")}`;

beforeAll(async () => {
  resetPluginHost();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  root = mkdtempSync(join(tmpdir(), "t1257-build-"));
  restoreBaseUrl = await pinSiteBaseUrl(ADMIN_URL, BASE);
  restoreLanguage = await pinSiteLanguage(ADMIN_URL, "en");
  const tpl = await run<{ templateId: string }>("templates.create", {
    pageType: "home",
    slug: "t1257-tpl",
    displayName: "T1257",
    html: `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
  });
  templateId = tpl.templateId;
  await run("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  ids.hub = await createPage("t1257-guides", "T1257 Guides");
  for (let i = 1; i <= GUIDES; i += 1) {
    await createPage(`t1257-g${String(i).padStart(2, "0")}`, guide(i), ids.hub);
  }
  const built = await run<{ placements: { contentInstanceId: string }[] }>("pages.build_page", {
    page: { pageId: ids.hub },
    modules: [
      {
        blockName: "content",
        displayName: "T1257 guides overview",
        description: "Every guide, 20 per page, with a pager above the list.",
        kind: "content",
        // The pager comes FIRST: page 1 needs the second render pass.
        html: `<section>${PAGER_HTML}<ul>{{#guides}}<li>{{title}}</li>{{/guides}}</ul></section>`,
        fields: [
          PAGER_FIELD,
          {
            name: "guides",
            kind: "list",
            label: "Guides",
            listType: "links",
            bind: "source",
            source: guidesQuery(),
            paginate: { per_page: 20 },
          },
        ],
        content: { source: "inline", values: {} },
      },
    ],
  });
  ids.overviewInstance = built.placements[0]?.contentInstanceId ?? "";
});

afterAll(async () => {
  try {
    await cleanup();
  } finally {
    try {
      await restoreBaseUrl?.();
      await restoreLanguage?.();
    } finally {
      rmSync(root, { recursive: true, force: true });
      await adapter.close();
    }
  }
});

describe("#1257 paginated overview — editor preview", () => {
  it("page 1 shows the first 20 and a complete pager although the pager comes first", async () => {
    const r = await run<{ html: string; missingSlots: string[] }>("pages.render_preview", {
      pageId: ids.hub,
    });
    expect(titles(r.html)).toEqual(Array.from({ length: 20 }, (_, i) => guide(i + 1)));
    expect(r.html).toContain('<span aria-current="page">1</span>');
    expect(r.html).toContain('href="/t1257-guides/page/3/">3</a>');
    expect(r.html).toContain('<a rel="next" href="/t1257-guides/page/2/">next</a>');
    expect(r.missingSlots.filter((m) => m.startsWith("list-"))).toEqual([]);
  });

  it("serves a follow-up page at <path>/page/<n>, self-canonical", async () => {
    const r = await run<{ html: string; pagePath: string; pageId: string }>(
      "pages.render_preview",
      { path: "/t1257-guides/page/3" },
    );
    expect(r.pageId).toBe(ids.hub);
    expect(r.pagePath).toBe("/t1257-guides/page/3");
    expect(titles(r.html)).toEqual(Array.from({ length: 15 }, (_, i) => guide(i + 41)));
    expect(r.html).toContain('<a rel="prev" href="/t1257-guides/page/2/">prev</a>');
    expect(r.html).toContain('<a href="/t1257-guides/">1</a>');
    expect(canonicalOf(r.html)).toBe(`${BASE}/t1257-guides/page/3/`);
    expect(noindex(r.html)).toBe(false);
  });

  it("a page number beyond the sequence is not found", async () => {
    const r = await execute(registry, adapter, SYS, "pages.render_preview", {
      path: "/t1257-guides/page/4",
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.ok ? null : r.error)).toContain("page not found");
  });

  it("preview_list_source reports the whole sequence", async () => {
    const v = await run<{ count: number; total: number; pagination?: unknown }>(
      "lists.preview_source",
      {
        moduleId: (
          await sqlSystem(
            (tx) =>
              tx`SELECT module_id::text AS id FROM content_instances WHERE id = ${ids.overviewInstance}::uuid`,
          )
        )[0].id,
        field: "guides",
        contentInstanceId: ids.overviewInstance,
        pageId: ids.hub,
      },
    );
    expect(v).toMatchObject({
      count: 20,
      total: GUIDES,
      pagination: { perPage: 20, pageCount: 3, followUps: "index" },
    });
  });
});

describe("#1257 paginated overview — static build", () => {
  it("emits every follow-up page, self-canonical, in the sitemap and the routing manifest", async () => {
    const runId = "t1257-index";
    await build(runId);
    expect(titles(await read(runId, "t1257-guides/index.html"))).toHaveLength(20);
    const p2 = await read(runId, "t1257-guides/page/2/index.html");
    expect(titles(p2)).toEqual(Array.from({ length: 20 }, (_, i) => guide(i + 21)));
    expect(canonicalOf(p2)).toBe(`${BASE}/t1257-guides/page/2/`);
    expect(noindex(p2)).toBe(false);
    expect(titles(await read(runId, "t1257-guides/page/3/index.html"))).toHaveLength(15);
    expect(await exists(fileOf(runId, "t1257-guides/page/4/index.html"))).toBe(false);
    expect(await exists(fileOf(runId, "t1257-guides/page/1/index.html"))).toBe(false);

    const sitemap = await read(runId, "sitemap.xml");
    expect(sitemap).toContain(`<loc>${BASE}/t1257-guides/page/2/</loc>`);
    expect(sitemap).toContain(`<loc>${BASE}/t1257-guides/page/3/</loc>`);
    const manifest = JSON.parse(await read(runId, "routing-manifest.json")) as {
      pages: { pageId: string; followUpOutputPaths?: string[] }[];
    };
    expect(manifest.pages.find((p) => p.pageId === ids.hub)?.followUpOutputPaths).toEqual([
      "t1257-guides/page/2/index.html",
      "t1257-guides/page/3/index.html",
    ]);
  });

  it("follow_ups: noindex on the placement keeps follow-up pages out of search", async () => {
    await run("content_instances.set_values", {
      id: ids.overviewInstance,
      values: { guides: { paginate: { follow_ups: "noindex" } } },
    });
    try {
      const runId = "t1257-noindex";
      await build(runId);
      const p1 = await read(runId, "t1257-guides/index.html");
      const p2 = await read(runId, "t1257-guides/page/2/index.html");
      expect(noindex(p1)).toBe(false);
      expect(noindex(p2)).toBe(true);
      // Still self-canonical: noindex does not point page 2 at page 1.
      expect(canonicalOf(p2)).toBe(`${BASE}/t1257-guides/page/2/`);
      const sitemap = await read(runId, "sitemap.xml");
      expect(sitemap).toContain(`<loc>${BASE}/t1257-guides/</loc>`);
      expect(sitemap).not.toContain("/t1257-guides/page/");
      const preview = await run<{ html: string }>("pages.render_preview", {
        path: "/t1257-guides/page/2",
      });
      expect(noindex(preview.html)).toBe(true);
    } finally {
      await run("content_instances.set_values", { id: ids.overviewInstance, values: {} });
    }
  });

  it("refuses paginate overrides on a field that is not paginated", async () => {
    const page = await createPage("t1257-capped", "T1257 Capped");
    ids.capped = page;
    const built = await run<{ placements: { contentInstanceId: string }[] }>("pages.build_page", {
      page: { pageId: page },
      modules: [
        {
          blockName: "content",
          displayName: "T1257 capped list",
          description: "Every guide in one list, capped by the query limit.",
          kind: "content",
          html: "<ul>{{#all}}<li>{{title}}</li>{{/all}}</ul>",
          fields: [
            {
              name: "all",
              kind: "list",
              label: "All guides",
              listType: "links",
              bind: "source",
              source: {
                kind: "query",
                editable: [],
                defaults: { parent: hubRef(), order: "title_asc", limit: 50 },
              },
            },
          ],
          content: { source: "inline", values: {} },
        },
      ],
    });
    const r = await execute(registry, adapter, SYS, "content_instances.set_values", {
      id: built.placements[0]?.contentInstanceId,
      values: { all: { paginate: { per_page: 10 } } },
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.ok ? null : r.error)).toContain("is not paginated");
  });

  it("reports a list cut at the query cap instead of cutting it silently", async () => {
    const runId = "t1257-capped";
    const result = await build(runId, [ids.capped]);
    expect(result.truncatedLists).toEqual([
      {
        pageSlug: "t1257-capped",
        pagePath: "/t1257-capped",
        field: "all",
        shown: 50,
        total: GUIDES,
        limit: 50,
      },
    ]);
  });

  it("refuses a page split over several pages without a pager", async () => {
    ids.noPager = await createPage("t1257-nopager", "T1257 No pager");
    await run("pages.build_page", {
      page: { pageId: ids.noPager },
      modules: [
        {
          blockName: "content",
          displayName: "T1257 overview without pager",
          description: "Every guide, 30 per page, but no pager.",
          kind: "content",
          html: "<ul>{{#guides}}<li>{{title}}</li>{{/guides}}</ul>",
          fields: [
            {
              name: "guides",
              kind: "list",
              label: "Guides",
              listType: "links",
              bind: "source",
              source: guidesQuery(),
              paginate: { per_page: 30 },
            },
          ],
          content: { source: "inline", values: {} },
        },
      ],
    });
    const preview = await run<{ missingSlots: string[] }>("pages.render_preview", {
      pageId: ids.noPager,
    });
    expect(preview.missingSlots).toContain("list-pager-missing:guides");
    await expect(build("t1257-nopager", [ids.noPager])).rejects.toThrow(/renders no pager/);
  });
});
