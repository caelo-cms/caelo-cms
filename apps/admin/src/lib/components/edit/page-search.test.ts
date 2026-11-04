// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { type PageSearchSources, pageSearchGroups, searchPages } from "./page-search.js";

const page = (id: string, title: string, currentPath: string) => ({
  id,
  slug: currentPath.slice(1) || "home",
  title,
  status: "published" as const,
  currentPath,
});
const home = page("h", "Welcome", "/");
const about = page("a", "About us", "/about");
const pricing = page("p", "Plans", "/pricing");

const sources = (over: Partial<PageSearchSources> = {}): PageSearchSources => ({
  recent: [],
  first: { pages: [pricing, home, about], more: false },
  results: null,
  ...over,
});
const ids = (groups: ReturnType<typeof pageSearchGroups>) =>
  groups.map((g) => [g.heading, g.pages.map((p) => p.id), g.more]);

describe("pageSearchGroups", () => {
  it("opens with the recently edited pages, then the site's first pages by path", () => {
    expect(ids(pageSearchGroups(sources({ recent: [pricing, about] }), ""))).toEqual([
      ["Recently edited", ["p", "a"], false],
      ["Other pages", ["h"], false],
    ]);
  });

  it("lists the first pages alone when nothing was edited yet, and says when there are more", () => {
    expect(ids(pageSearchGroups(sources(), "  "))).toEqual([["Pages", ["h", "a", "p"], false]]);
    const big = sources({ first: { pages: [home], more: true } });
    expect(ids(pageSearchGroups(big, ""))).toEqual([["Pages", ["h"], true]]);
  });

  it("shows the server's results for a query, by path, once each", () => {
    const results = { pages: [pricing, about, pricing], more: true };
    expect(ids(pageSearchGroups(sources({ results }), "pla"))).toEqual([
      ["Pages", ["a", "p"], true],
    ]);
  });

  it("answers no groups while the results are on their way, or when nothing matches", () => {
    expect(pageSearchGroups(sources(), "pla")).toEqual([]);
    expect(pageSearchGroups(sources({ results: { pages: [], more: false } }), "zzz")).toEqual([]);
  });
});

describe("searchPages", () => {
  it("asks the search route in the chat's view and refuses a failed answer", async () => {
    let asked = "";
    const ok = (async (url: string) => {
      asked = url;
      return new Response(JSON.stringify({ pages: [about], more: false }));
    }) as unknown as typeof fetch;
    const r = await searchPages("about us", "b-1", new AbortController().signal, ok);
    expect(asked).toBe("/api/pages/search?q=about+us&branch=b-1");
    expect(r.pages).toEqual([about]);
    const failed = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    await expect(searchPages("x", "b-1", new AbortController().signal, failed)).rejects.toThrow(
      "500",
    );
  });
});
