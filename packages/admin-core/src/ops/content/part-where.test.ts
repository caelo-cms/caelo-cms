// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { describeWhere, type PartPlacement, samplePathOf, wherePartShows } from "./part-where.js";

const page = (path: string) => ({ pageId: `id${path}`, path, title: path });
const placement = (over: Partial<PartPlacement>): PartPlacement => ({
  pages: [],
  morePages: false,
  inLayout: false,
  lists: [],
  ...over,
});

describe("wherePartShows", () => {
  it("is a change of the one page that shows it", () => {
    expect(wherePartShows(placement({ pages: [page("/pricing")] }))).toEqual({
      kind: "page",
      page: page("/pricing"),
    });
  });

  it("is nothing a visitor sees when no page shows it", () => {
    expect(wherePartShows(placement({}))).toEqual({ kind: "nowhere" });
  });

  it("counts only the pages `shown` keeps: a draft page reaches no visitor", () => {
    const p = placement({ pages: [page("/draft"), page("/live")] });
    expect(wherePartShows(p, (id) => id === "id/live")).toEqual({
      kind: "page",
      page: page("/live"),
    });
    expect(wherePartShows(p, () => false)).toEqual({ kind: "nowhere" });
  });

  it("is site-wide on two pages, in layout chrome, in a shared list or past the read cap", () => {
    for (const p of [
      placement({ pages: [page("/a"), page("/b")] }),
      placement({ inLayout: true }),
      placement({ lists: ["Main menu"] }),
      placement({ pages: [page("/a")], morePages: true }),
    ]) {
      expect(wherePartShows(p).kind).toBe("many");
    }
  });
});

describe("describeWhere", () => {
  const many = (p: PartPlacement) => {
    const w = wherePartShows(p);
    if (w.kind !== "many") throw new Error("expected many");
    return w;
  };

  it("says where a site-wide part shows, in the operator's words", () => {
    expect(describeWhere(many(placement({ pages: [page("/a"), page("/b"), page("/c")] })))).toBe(
      "on 3 pages",
    );
    expect(describeWhere(many(placement({ inLayout: true, pages: [page("/a")] })))).toBe(
      "in the site layout",
    );
    expect(describeWhere(many(placement({ lists: ["Main menu"] })))).toBe("in the list Main menu");
    expect(describeWhere(many(placement({ lists: ["Main menu", "Footer"] })))).toBe("in 2 lists");
    expect(describeWhere(many(placement({ pages: [page("/a")], morePages: true })))).toBe(
      "on many pages",
    );
  });

  it("names a page to look at: the first one, or the home page for chrome and lists", () => {
    expect(samplePathOf(many(placement({ pages: [page("/a"), page("/b")] })))).toBe("/a");
    expect(samplePathOf(many(placement({ inLayout: true })))).toBe("/");
  });
});
