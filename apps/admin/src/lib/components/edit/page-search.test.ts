// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  type PageSearchSources,
  pageSearchGroups,
  searchPages,
  searchPagesUntilFound,
} from "./page-search.js";

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

const signal = () => new AbortController().signal;

describe("searchPages", () => {
  it("asks the search route in the chat's view, with the cursor when continuing", async () => {
    const asked: string[] = [];
    const fetcher = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ pages: [about], nextCursor: null }));
    }) as unknown as typeof fetch;
    const r = await searchPages("about us", "b-1", signal(), { fetcher });
    await searchPages("about us", "b-1", signal(), { fetcher, cursor: "c1" });
    expect(asked).toEqual([
      "/api/pages/search?q=about+us&branch=b-1",
      "/api/pages/search?q=about+us&branch=b-1&cursor=c1",
    ]);
    expect(r).toEqual({ pages: [about], nextCursor: null });
  });

  it("refuses a failed answer with the route's reason, or the status alone", async () => {
    const withReason = (async () =>
      new Response(JSON.stringify({ message: "Branch not found" }), {
        status: 404,
      })) as unknown as typeof fetch;
    await expect(searchPages("x", "b-1", signal(), { fetcher: withReason })).rejects.toThrow(
      "The page search failed (404): Branch not found.",
    );
    const bare = (async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch;
    await expect(searchPages("x", "b-1", signal(), { fetcher: bare })).rejects.toThrow(
      "The page search failed (502).",
    );
  });
});

describe("searchPagesUntilFound", () => {
  it("continues past calls that stopped at their cap with nothing found", async () => {
    const answers = [
      { pages: [], nextCursor: "c1" },
      { pages: [], nextCursor: "c2" },
      { pages: [pricing], nextCursor: "c3" },
    ];
    const asked: string[] = [];
    const fetcher = (async (url: string) => {
      asked.push(new URL(url, "http://x").searchParams.get("cursor") ?? "-");
      return new Response(JSON.stringify(answers.shift()));
    }) as unknown as typeof fetch;
    const r = await searchPagesUntilFound("pla", "b-1", signal(), { fetcher });
    expect(asked).toEqual(["-", "c1", "c2"]);
    expect(r).toEqual({ pages: [pricing], nextCursor: "c3" });
  });
});
