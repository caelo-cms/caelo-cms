// SPDX-License-Identifier: MPL-2.0

/**
 * The one rule hreflang output and the Stage audit share: a noindex page
 * takes no part in hreflang (./hreflang.ts).
 */

import { describe, expect, it } from "bun:test";
import { hreflangSet, robotsNoindex } from "./hreflang.js";

const v = (pageId: string, isDefault = false) => ({ pageId, isDefault });

describe("hreflangSet", () => {
  const noindexOf = (ids: string[]) => (id: string) => ids.includes(id);

  it("keeps every version of an all-indexable group, in order", () => {
    const group = [v("en", true), v("de"), v("fr")];
    expect(hreflangSet("de", group, noindexOf([]))).toEqual(group);
  });

  it("gives a noindex page no set", () => {
    expect(hreflangSet("en", [v("en", true), v("de")], noindexOf(["en"]))).toEqual([]);
  });

  it("two noindex search results pages: neither gets a set", () => {
    const group = [v("suche", true), v("search")];
    const both = noindexOf(["suche", "search"]);
    expect(hreflangSet("suche", group, both)).toEqual([]);
    expect(hreflangSet("search", group, both)).toEqual([]);
  });

  it("leaves a noindex sibling out, and no set when only the page itself is left", () => {
    expect(hreflangSet("en", [v("en", true), v("de"), v("fr")], noindexOf(["fr"]))).toEqual([
      v("en", true),
      v("de"),
    ]);
    expect(hreflangSet("en", [v("en", true), v("de")], noindexOf(["de"]))).toEqual([]);
  });

  it("drops the default version when it is noindex, so x-default has nothing to name", () => {
    const set = hreflangSet("de", [v("en", true), v("de"), v("fr")], noindexOf(["en"]));
    expect(set).toEqual([v("de"), v("fr")]);
    expect(set.find((x) => x.isDefault)).toBeUndefined();
  });
});

describe("robotsNoindex", () => {
  it("reads the directives of a robots meta, lower-case", () => {
    expect(robotsNoindex(null)).toBe(false);
    expect(robotsNoindex("")).toBe(false);
    expect(robotsNoindex("index, follow")).toBe(false);
    expect(robotsNoindex("noindex")).toBe(true);
    expect(robotsNoindex("noindex, nofollow")).toBe(true);
    expect(robotsNoindex("follow,noindex")).toBe(true);
    expect(robotsNoindex("none")).toBe(true);
    expect(robotsNoindex("nofollow")).toBe(false);
  });
});
