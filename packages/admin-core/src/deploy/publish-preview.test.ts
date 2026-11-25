// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { PartWhere } from "../ops/content/part-where.js";
import { classifyRelease, placedPartsOfRelease } from "./publish-preview.js";

const page = (pageId: string, path: string) => ({ pageId, path, title: path });

describe("classifyRelease", () => {
  it("counts content and a section design shown on one page as a change of that page", () => {
    const fingerprint = [
      { kind: "page", id: "new-page", change: "added" as const },
      { kind: "module", id: "made-for-new-page", change: "added" as const },
    ];
    const staged = [
      { kind: "contentInstance", id: "pricing-hero" },
      { kind: "contentInstance", id: "new-page-form" },
    ];
    expect(placedPartsOfRelease({ fingerprint, staged })).toEqual([
      { kind: "module", id: "made-for-new-page" },
      { kind: "contentInstance", id: "pricing-hero" },
      { kind: "contentInstance", id: "new-page-form" },
    ]);
    const release = classifyRelease({
      fingerprint,
      staged,
      publishedInStaged: new Set(["new-page", "pricing"]),
      where: new Map<string, PartWhere>([
        ["module:made-for-new-page", { kind: "page", page: page("new-page", "/check") }],
        ["contentInstance:pricing-hero", { kind: "page", page: page("pricing", "/pricing") }],
        ["contentInstance:new-page-form", { kind: "page", page: page("new-page", "/check") }],
      ]),
    });
    expect(release.newPageIds).toEqual(["new-page"]);
    // The new page stays new; the pricing page changed; nothing is site-wide.
    expect(release.changedPageIds).toEqual(["pricing"]);
    expect(release.siteWide).toEqual([]);
  });

  it("lists a part shown on many pages as site-wide, with where it shows", () => {
    const release = classifyRelease({
      fingerprint: [{ kind: "module", id: "tile", change: "changed" }],
      staged: [
        { kind: "contentInstance", id: "faq" },
        { kind: "list", id: "menu" },
      ],
      publishedInStaged: new Set(),
      where: new Map<string, PartWhere>([
        [
          "module:tile",
          {
            kind: "many",
            pages: [page("a", "/a"), page("b", "/b")],
            morePages: false,
            inLayout: false,
            lists: [],
          },
        ],
        ["contentInstance:faq", { kind: "nowhere" }],
      ]),
    });
    expect(release.siteWide).toEqual([
      { kind: "module", id: "tile", change: "changed", shows: "on 2 pages", samplePath: "/a" },
      // A list is site-wide by nature; content no page shows is not listed.
      { kind: "list", id: "menu", change: "changed", shows: null, samplePath: null },
    ]);
  });

  it("keeps a removed section design as removed: no page shows it any more", () => {
    const fingerprint = [{ kind: "module", id: "old", change: "removed" as const }];
    expect(placedPartsOfRelease({ fingerprint, staged: [] })).toEqual([]);
    const release = classifyRelease({
      fingerprint,
      staged: [],
      publishedInStaged: new Set(),
      where: new Map(),
    });
    expect(release.siteWide).toEqual([
      { kind: "module", id: "old", change: "removed", shows: null, samplePath: null },
    ]);
  });

  it("refuses a section design or content whose placement was not read", () => {
    expect(() =>
      classifyRelease({
        fingerprint: [],
        staged: [{ kind: "contentInstance", id: "ci" }],
        publishedInStaged: new Set(),
        where: new Map(),
      }),
    ).toThrow(/no placement/);
  });
});
