// SPDX-License-Identifier: MPL-2.0

/** #1757, #1760 — duplicates, the overview panel's rows and the editor previews. */

import { describe, expect, it } from "bun:test";
import {
  manifestFromDefinition,
  type PluginContextTier1,
  pluginAuditFinding,
  pluginEditorToolbarState,
  pluginManifest,
} from "@caelo-cms/plugin-sdk";
import seo from "../index.js";
import { DUPLICATES_AUDIT_RULE, duplicateFindings } from "./duplicates.js";
import { overviewPageTypes, overviewRows } from "./overview.js";
import { displayUrl, seoPreview } from "./previews.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const head = (
  n: number,
  title: string,
  description: string,
  over: Record<string, unknown> = {},
) => ({
  pageId: id(n),
  path: `/p${n}`,
  title: `Page ${n}`,
  status: "published",
  pageType: "article",
  seoTitle: { value: title, origin: "page_type" },
  metaDescription: { value: description, origin: "ai" },
  robots: "max-image-preview:large",
  noindex: false,
  canonicalUrl: null,
  findings: [] as { ruleId: string; severity: string; message: string }[],
  ...over,
});

describe("duplicate titles and descriptions", () => {
  it("flags every indexable page of a group, and no page that does not compete", () => {
    const heads = [
      head(1, "Pricing", "Prices for teams."),
      head(2, "Pricing", "Other text."),
      head(3, "Pricing", "Prices for teams.", { noindex: true }),
      head(4, "Pricing", "Prices for teams.", { canonicalUrl: "https://x.example/p1/" }),
      head(5, "About", ""),
      head(6, "Contact", ""),
    ];
    const titles = duplicateFindings(heads, "seoTitle");
    expect(titles.map((f) => f.pageId)).toEqual([id(1), id(2)]);
    expect(titles[0]?.message).toContain("/p2");
    expect(titles[0]?.fix?.tool).toBe("bulk_optimize_seo");
    // An empty description is no duplicate of another empty one.
    expect(duplicateFindings(heads, "metaDescription")).toEqual([]);
  });

  it("keeps every message within the SDK's length, whatever the paths", () => {
    const long = (n: number) => head(n, "Shared", "x", { path: `/${"deep/".repeat(36)}page-${n}` });
    const found = duplicateFindings(
      Array.from({ length: 7 }, (_, i) => long(i)),
      "seoTitle",
    );
    expect(found).toHaveLength(7);
    for (const f of found) expect(pluginAuditFinding.safeParse(f).success).toBe(true);
    expect(found[0]?.message).toContain("and 1 more");
  });

  it("stays linear for a title 50,000 pages share", () => {
    const heads = Array.from({ length: 50_000 }, (_, i) => head(i, "Shop", "Buy."));
    const started = performance.now();
    const found = duplicateFindings(heads, "seoTitle");
    expect(found).toHaveLength(50_000);
    expect(found[49_999]?.message).toContain("and 49994 more");
    // Quadratic grouping took about 79 s here; linear takes well under one.
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("reads the staged pages a thousand at a time", async () => {
    const calls: number[] = [];
    const ctx = {
      cms: {
        call: async (_op: string, input: { pageIds: string[] }) => {
          calls.push(input.pageIds.length);
          return {
            pages: input.pageIds.map((p, i) => head(i, "Same", `D ${p}`, { pageId: p })),
            nextCursor: null,
          };
        },
      },
    } as unknown as PluginContextTier1;
    const pages = Array.from({ length: 2500 }, (_, i) => ({ pageId: id(i), path: `/p${i}` }));
    const found = await DUPLICATES_AUDIT_RULE.site?.(ctx, { pages, runId: undefined });
    expect(calls).toEqual([1000, 1000, 500]);
    expect(found?.filter((f) => f.rule === "duplicate-title")).toHaveLength(2500);
  });
});

describe("the overview panel", () => {
  it("is a valid panel on the manifest, with a link into the editor", () => {
    const manifest = pluginManifest.parse(manifestFromDefinition(seo));
    const panel = manifest.adminPanels?.find((p) => p.slug === "overview");
    expect(panel).toBeDefined();
    const table = panel?.sections[0];
    expect(table?.kind).toBe("table");
    if (table?.kind !== "table") return;
    expect(table.columns.find((c) => c.format === "page")?.key).toBe("pageId");
    expect(table.filters?.map((f) => f.arg)).toEqual(["pageType", "origin", "finding"]);
  });

  it("maps core's rows and reads on past empty pages", async () => {
    const answers = [
      { pages: [], nextCursor: "c1" },
      {
        pages: [
          head(1, "Pricing", "Prices.", {
            findings: [{ ruleId: "plugin.seo/h1-count", severity: "error", message: "x" }],
          }),
        ],
        nextCursor: null,
      },
    ];
    const seen: Record<string, unknown>[] = [];
    const ctx = {
      cms: {
        call: async (_op: string, input: Record<string, unknown>) => {
          seen.push(input);
          return answers.shift();
        },
      },
    } as unknown as PluginContextTier1;
    const r = await overviewRows(ctx, { finding: "plugin.seo/", limit: 50 });
    expect(seen.map((s) => s.cursor)).toEqual([undefined, "c1"]);
    expect(r.hasMore).toBe(false);
    expect(r.rows[0]).toMatchObject({
      pageId: id(1),
      seoTitle: "Pricing",
      titleOrigin: "page_type",
      findings: ["h1-count"],
      indexing: "indexed",
    });
  });

  it("keeps the next cursor when every read part of the site had no match", async () => {
    let n = 0;
    const ctx = {
      cms: { call: async () => ({ pages: [], nextCursor: `c${++n}` }) },
    } as unknown as PluginContextTier1;
    const r = await overviewRows(ctx, { origin: "unset", limit: 50 });
    // No row to carry it: the answer does, and the panel names it.
    expect(r).toEqual({ rows: [], hasMore: true, nextCursor: `c${n}` });
    const manifest = pluginManifest.parse(manifestFromDefinition(seo));
    const table = manifest.adminPanels?.find((p) => p.slug === "overview")?.sections[0];
    expect(table?.kind === "table" ? table.paging?.nextCursorKey : undefined).toBe("nextCursor");
  });

  it("offers the site's page types as a filter", async () => {
    const ctx = {
      cms: { call: async () => ({ pageTypes: [{ id: id(9), name: "Article", slug: "article" }] }) },
    } as unknown as PluginContextTier1;
    expect(await overviewPageTypes(ctx)).toEqual({ options: [{ value: id(9), label: "Article" }] });
  });
});

describe("the search and share preview", () => {
  const ctx = (resolved: unknown, url = "https://example.com/blog/hello-world/") =>
    ({
      cms: {
        call: async (op: string) => {
          if (op === "pages_seo.get") return { seo: null, resolved };
          if (op === "pages.resolve_public_urls") return { urls: { [id(1)]: url } };
          if (op === "site_defaults.get_seo") return { siteBaseUrl: "https://example.com" };
          if (op === "pages_seo.share_images")
            return { images: [{ pageId: id(1), assetId: id(7), source: "site" }] };
          throw new Error(op);
        },
      },
    }) as unknown as PluginContextTier1;
  const v = (value: string, origin = "human") => ({ value, origin });

  it("shows the resolved values, cut where a result list cuts them", async () => {
    const state = await seoPreview(
      ctx({
        title: v("The complete guide to choosing a content management system for a growing team"),
        metaDescription: v("A short description."),
        ogTitle: v("", "inherited"),
        ogDescription: v("Share text.", "human"),
        robots: "max-image-preview:large",
      }),
      { pageId: id(1) },
    );
    expect(pluginEditorToolbarState.safeParse(state).success).toBe(true);
    const [desktop, mobile, card] = state.previews ?? [];
    expect(desktop).toMatchObject({
      kind: "search-result",
      device: "desktop",
      displayUrl: "example.com › blog › hello-world",
    });
    if (desktop?.kind !== "search-result" || mobile?.kind !== "search-result")
      throw new Error("results");
    expect(desktop.title.endsWith("…")).toBe(true);
    expect(mobile.title.length).toBeGreaterThanOrEqual(desktop.title.length);
    expect(card).toMatchObject({
      kind: "social-card",
      imageAssetId: id(7),
      description: "Share text.",
    });
    expect(state.summary).toContain("ends in …");
  });

  it("shows a site-relative canonical override on the site's address", async () => {
    const state = await seoPreview(
      ctx(
        {
          title: v("Pricing"),
          metaDescription: v("Prices."),
          ogTitle: v("", "inherited"),
          ogDescription: v("", "inherited"),
          robots: "",
        },
        "/preferred-page/",
      ),
      { pageId: id(1) },
    );
    expect(state.previews?.[0]).toMatchObject({
      siteName: "example.com",
      displayUrl: "example.com › preferred-page",
    });
  });

  it("says when there is no description, and hides for a page it cannot see", async () => {
    const state = await seoPreview(
      ctx({
        title: v("Pricing"),
        metaDescription: v("", "unset"),
        ogTitle: v("", "inherited"),
        ogDescription: v("", "inherited"),
        robots: "noindex",
      }),
      { pageId: id(1) },
    );
    expect(state.tone).toBe("attention");
    expect(state.summary).toContain("noindex");
    expect(await seoPreview(ctx(null), { pageId: id(1) })).toEqual({ hidden: true });
    expect(displayUrl("https://example.com/")).toBe("example.com");
  });
});
