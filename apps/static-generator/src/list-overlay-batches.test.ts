// SPDX-License-Identifier: MPL-2.0

/**
 * #1307 — the build asks `list-resolve` per page batch, scoped to what the
 * batch's pages show: the shared lists and the generated-page set once per
 * variant (kept), the batch's instances and pages per batch, one pass id
 * for the whole build, and never a call without a scope.
 */

import { describe, expect, it } from "bun:test";
import type { BuildPluginServices, ResolvedListOverlays } from "@caelo-cms/plugin-host";
import type {
  ListOverlayScope,
  ListPageRecord,
  ListRenderData,
  ListTypeDef,
  ScopedModule,
} from "@caelo-cms/shared";
import {
  BuildListOverlays,
  KEPT_PAGES_PER_CALL,
  type OverlayBatchPage,
} from "./list-overlay-batches.js";

const P = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CI = (n: number): string => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;

function page(id: string, pageTypeSlug: string): ListPageRecord {
  return {
    id,
    title: id,
    shortTitle: id,
    parentId: null,
    pageTypeSlug,
    properties: {},
    terms: [],
    firstPublishedAt: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
    summary: null,
    image: null,
    inBuild: true,
  } as ListPageRecord;
}

function listType(slug: string, source?: { kind: string }): ListTypeDef {
  return {
    slug,
    name: slug,
    purpose: slug,
    role: "content",
    root: { allow: ["entry"] },
    nodes: {
      entry: { label: "Entry", fields: [{ name: "label", label: "Label", type: "text" }] },
      ...(source ? { feed: { label: "Feed", fields: [], source } } : {}),
    },
  } as ListTypeDef;
}

/**
 * `n` English/German pairs: P(1..n) English, P(n+1..2n) German, all
 * products (a property), plus German P(9000) without a variant group.
 */
function site(n: number): ListRenderData {
  const pages = new Map<string, ListPageRecord>();
  const pageVariants = new Map<string, { variant: string; group: string | null }>();
  for (let i = 1; i <= 2 * n; i += 1) {
    pages.set(P(i), page(P(i), "product"));
    pageVariants.set(P(i), { variant: i <= n ? "en" : "de", group: `g${((i - 1) % n) + 1}` });
  }
  return {
    listTypes: new Map([
      ["nav", { id: "t1", def: listType("nav") }],
      ["feed", { id: "t2", def: listType("feed", { kind: "query" }) }],
    ]),
    lists: new Map([["l1", { id: "l1", slug: "menu", name: "Menu", typeSlug: "nav", items: [] }]]),
    pageTypes: new Map([
      [
        "product",
        {
          id: "pt1",
          def: { slug: "product", properties: [{ name: "tagline", label: "T", type: "text" }] },
        },
      ],
    ]),
    pages,
    media: new Map(),
    pageVariants,
    siteLanguage: "en",
    homePageId: null,
  } as unknown as ListRenderData;
}

const menu: ScopedModule = {
  fields: [{ name: "menu", kind: "list", listType: "nav", bind: "shared", list: "caelo:list/l1" }],
  html: "{{#menu}}{{label}}{{/menu}}",
};
const news: ScopedModule = { fields: [{ name: "news", kind: "list", listType: "feed" }], html: "" };
const plain: ScopedModule = { fields: [{ name: "title" }], html: "<h1>{{title}}</h1>" };

function batchPage(n: number, modules: ScopedModule[]): OverlayBatchPage {
  return { pageId: P(n), modules, markup: ["<body></body>"], contentInstanceIds: [CI(n)] };
}

interface Call {
  readonly variants: string[];
  readonly scope: ListOverlayScope;
  readonly passId: string;
}

/** A plugin answering every address of the scope (a list value, instance values, page props). */
function recordingPlugins(calls: Call[]): BuildPluginServices {
  const resolveListOverlays = async (
    variants: string[],
    scope: ListOverlayScope,
    passId: string,
  ): Promise<ResolvedListOverlays> => {
    calls.push({ variants, scope, passId });
    const values: Record<string, unknown> = {};
    const hidden: string[] = [];
    for (const l of scope.listIds) {
      values[`list/${l}/item/e1/label`] = `${variants[0]}:menu`;
      hidden.push(`list/${l}/item/e2`);
    }
    for (const ci of scope.contentInstanceIds) values[`instance/${ci}/f/item/i1/t`] = "x";
    for (const p of scope.pageIds) values[`page/${p}/props/tagline`] = `${variants[0]}:${p}`;
    return { plugins: [{ slug: "intl", overlays: { [variants[0] ?? ""]: { values, hidden } } }] };
  };
  return { resolveListOverlays } as unknown as BuildPluginServices;
}

describe("BuildListOverlays (#1307)", () => {
  it("asks per batch with only the batch's pages and instances; the lists once per variant", async () => {
    const calls: Call[] = [];
    const overlays = new BuildListOverlays(recordingPlugins(calls), site(4), "pass-1");

    const first = await overlays.forBatch([batchPage(5, [menu]), batchPage(6, [menu])]);
    const second = await overlays.forBatch([batchPage(7, [menu]), batchPage(8, [plain])]);

    expect(calls).toEqual([
      {
        variants: ["de"],
        scope: { listIds: ["l1"], contentInstanceIds: [CI(5), CI(6)], pageIds: [P(5), P(6)] },
        passId: "pass-1",
      },
      // P(8) shows no list: not in the scope. The menu is kept from the first batch.
      {
        variants: ["de"],
        scope: { listIds: [], contentInstanceIds: [CI(7)], pageIds: [P(7)] },
        passId: "pass-1",
      },
    ]);
    const de = (r: ResolvedListOverlays | undefined) => r?.plugins[0]?.overlays.de;
    expect(de(first)?.values[`page/${P(5)}/props/tagline`]).toBe(`de:${P(5)}`);
    // The second batch renders the kept menu, and none of the first batch's pages.
    expect(de(second)?.values["list/l1/item/e1/label"]).toBe("de:menu");
    expect(de(second)?.hidden).toEqual(["list/l1/item/e2"]);
    expect(de(second)?.values[`page/${P(5)}/props/tagline`]).toBeUndefined();
    expect(de(second)?.values[`instance/${CI(5)}/f/item/i1/t`]).toBeUndefined();
    expect(de(second)?.values[`page/${P(7)}/props/tagline`]).toBe(`de:${P(7)}`);
  });

  it("asks nothing for a batch that shows no list", async () => {
    const calls: Call[] = [];
    const overlays = new BuildListOverlays(recordingPlugins(calls), site(2), "pass-2");
    expect(await overlays.forBatch([batchPage(3, [plain])])).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("asks a variant's generated pages once, in slices, and keeps them for later batches", async () => {
    const n = KEPT_PAGES_PER_CALL + 5;
    const calls: Call[] = [];
    const overlays = new BuildListOverlays(recordingPlugins(calls), site(n), "pass-3");

    // A German overview with a page query: every German page with properties.
    const first = await overlays.forBatch([batchPage(n + 1, [news])]);
    // The overview itself plus the first slice of the others, then the rest.
    expect(calls.map((c) => c.scope.pageIds.length)).toEqual([KEPT_PAGES_PER_CALL + 1, 4]);
    expect(calls.every((c) => c.variants[0] === "de" && c.passId === "pass-3")).toBe(true);
    const de = first?.plugins[0]?.overlays.de;
    expect(Object.keys(de?.values ?? {}).filter((a) => a.startsWith("page/"))).toHaveLength(n);

    // A later overview of the same variant asks no kept page again — only
    // the first overview, whose own props were its batch's, not kept.
    calls.length = 0;
    const later = await overlays.forBatch([batchPage(n + 2, [news])]);
    expect(calls).toEqual([
      {
        variants: ["de"],
        scope: { listIds: [], contentInstanceIds: [CI(n + 2)], pageIds: [P(n + 1)] },
        passId: "pass-3",
      },
    ]);
    expect(later?.plugins[0]?.overlays.de?.values[`page/${P(2 * n)}/props/tagline`]).toBe(
      `de:${P(2 * n)}`,
    );
  });

  it("the cost of a batch call does not grow with the site", async () => {
    const scopeSize = async (pairs: number): Promise<number[]> => {
      const calls: Call[] = [];
      const overlays = new BuildListOverlays(recordingPlugins(calls), site(pairs), "pass-4");
      await overlays.forBatch([batchPage(pairs + 1, [menu])]);
      await overlays.forBatch([batchPage(pairs + 2, [menu])]);
      return calls.map(
        (c) => c.scope.listIds.length + c.scope.contentInstanceIds.length + c.scope.pageIds.length,
      );
    };
    expect(await scopeSize(10_000)).toEqual(await scopeSize(10));
  });

  it("attributes refused entries to the plugin that sent them", async () => {
    const calls: Call[] = [];
    const overlays = new BuildListOverlays(recordingPlugins(calls), site(2), "pass-5");
    await overlays.forBatch([batchPage(3, [menu])]);
    const issue = { variant: "de", address: "list/l1/item/e1/label", reason: "no such entry" };
    overlays.noteIssues([issue, issue]);
    const report = overlays.issueReport();
    expect(report.issues).toEqual([issue]);
    expect(report.sources).toEqual({
      plugins: [{ slug: "intl", overlays: { de: { values: {}, hidden: [issue.address] } } }],
    });
  });
});
