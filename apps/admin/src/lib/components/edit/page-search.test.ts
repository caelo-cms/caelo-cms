// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { MAX_MATCHES, pageSearchGroups } from "./page-search.js";

const home = { id: "h", title: "Welcome", currentPath: "/" };
const about = { id: "a", title: "About us", currentPath: "/about" };
const pricing = { id: "p", title: "Plans", currentPath: "/pricing" };
const pages = [pricing, home, about];

const ids = (groups: ReturnType<typeof pageSearchGroups>) =>
  groups.map((g) => [g.heading, g.pages.map((p) => p.id)]);

describe("pageSearchGroups", () => {
  it("opens with the recently edited pages, then every other page by path", () => {
    expect(ids(pageSearchGroups(pages, ["p", "a"], ""))).toEqual([
      ["Recently edited", ["p", "a"]],
      ["All other pages", ["h"]],
    ]);
  });

  it("lists all pages when nothing was edited yet", () => {
    expect(ids(pageSearchGroups(pages, [], "  "))).toEqual([["All pages", ["h", "a", "p"]]]);
  });

  it("skips a recent id the editor does not list", () => {
    expect(ids(pageSearchGroups(pages, ["gone", "a"], ""))[0]).toEqual(["Recently edited", ["a"]]);
  });

  it("matches a query against path and title, case-insensitively", () => {
    expect(ids(pageSearchGroups(pages, ["p"], "PLAN"))).toEqual([["Pages", ["p"]]]);
    expect(ids(pageSearchGroups(pages, [], "/ab"))).toEqual([["Pages", ["a"]]]);
  });

  it("answers no groups when nothing matches", () => {
    expect(pageSearchGroups(pages, [], "zzz")).toEqual([]);
  });

  it("caps a query's matches", () => {
    const many = Array.from({ length: MAX_MATCHES + 5 }, (_, i) => ({
      id: `x${i}`,
      title: `Doc ${i}`,
      currentPath: `/docs/${String(i).padStart(3, "0")}`,
    }));
    const [group] = pageSearchGroups(many, [], "docs");
    expect(group?.pages).toHaveLength(MAX_MATCHES);
    expect(group?.hidden).toBe(5);
  });

  it("caps the list of all pages too", () => {
    const many = Array.from({ length: MAX_MATCHES + 1 }, (_, i) => ({
      id: `x${i}`,
      title: `Doc ${i}`,
      currentPath: `/docs/${String(i).padStart(3, "0")}`,
    }));
    const [group] = pageSearchGroups(many, [], "");
    expect(group?.pages).toHaveLength(MAX_MATCHES);
    expect(group?.hidden).toBe(1);
  });
});
