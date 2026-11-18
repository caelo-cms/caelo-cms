// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { PartWhere } from "../content/part-where.js";
import { placedPartsOf, summarizeDraftChanges } from "./draft-summary.js";
import type { PendingChanges } from "./stage.js";

const NONE: ReadonlyMap<string, PartWhere> = new Map();

type Ref = PendingChanges["pending"]["pages"][number];

function changes(pending: Ref[], staged: Ref[] = []): PendingChanges {
  const split = (refs: Ref[]) => ({
    pages: refs.filter((r) => ["page", "pageLayout", "pageModuleContent"].includes(r.kind)),
    globals: refs.filter(
      (r) => !["page", "pageLayout", "pageModuleContent", "list"].includes(r.kind),
    ),
    lists: refs.filter((r) => r.kind === "list"),
  });
  return { pending: split(pending), staged: split(staged) };
}

const PRICING = "11111111-1111-4111-8111-111111111111";
const NEWPAGE = "22222222-2222-4222-8222-222222222222";
const GONE = "33333333-3333-4333-8333-333333333333";

const page = (path: string, pageId = `id${path}`) => ({ pageId, path, title: `Title of ${path}` });
const many = (paths: string[]): PartWhere => ({
  kind: "many",
  pages: paths.map((p) => page(p)),
  morePages: false,
  inLayout: false,
  lists: [],
});

describe("summarizeDraftChanges", () => {
  it("counts a page once however many of its parts changed", () => {
    const s = summarizeDraftChanges(
      changes([
        {
          kind: "pageModuleContent",
          entityId: "c1",
          label: "Pricing",
          pageId: PRICING,
          pagePath: "/pricing",
        },
        {
          kind: "pageModuleContent",
          entityId: "c2",
          label: "Pricing",
          pageId: PRICING,
          pagePath: "/pricing",
        },
        {
          kind: "pageLayout",
          entityId: PRICING,
          label: "Pricing",
          pageId: PRICING,
          pagePath: "/pricing",
        },
      ]),
      NONE,
    );
    expect(s.changedPages).toBe(1);
    expect(s.rows).toEqual([
      {
        key: `page:${PRICING}`,
        area: "page",
        change: "changed",
        title: "Pricing",
        path: "/pricing",
        what: "Text and images, sections",
        pageId: PRICING,
      },
    ]);
  });

  it("tells new, removed and SEO-only pages apart", () => {
    const s = summarizeDraftChanges(
      changes([
        {
          kind: "page",
          entityId: NEWPAGE,
          label: "Enterprise",
          pageId: NEWPAGE,
          pagePath: "/enterprise",
          change: "created",
        },
        {
          kind: "pageLayout",
          entityId: NEWPAGE,
          label: "Enterprise",
          pageId: NEWPAGE,
          pagePath: "/enterprise",
        },
        {
          kind: "page",
          entityId: GONE,
          label: "Old partners",
          pageId: GONE,
          pagePath: "/old-partners",
          change: "deleted",
        },
        {
          kind: "page",
          entityId: PRICING,
          label: "Pricing",
          pageId: PRICING,
          pagePath: "/pricing",
          seo: true,
        },
      ]),
      NONE,
    );
    expect([s.newPages, s.changedPages, s.removedPages]).toEqual([1, 1, 1]);
    // New first, then changed, then removed.
    expect(s.rows.map((r) => [r.change, r.what])).toEqual([
      ["new", "New page"],
      ["changed", "Search result text"],
      ["removed", "Removed"],
    ]);
  });

  it("leaves out a page made and deleted again in the draft", () => {
    const s = summarizeDraftChanges(
      changes([
        {
          kind: "page",
          entityId: NEWPAGE,
          label: "Scratch",
          pageId: NEWPAGE,
          change: "createdAndDeleted",
        },
        { kind: "pageLayout", entityId: NEWPAGE, label: "Scratch", pageId: NEWPAGE },
      ]),
      NONE,
    );
    expect(s).toEqual({ newPages: 0, changedPages: 0, removedPages: 0, siteWide: 0, rows: [] });
  });

  it("names site-wide parts for the operator, once each, after the pages", () => {
    const s = summarizeDraftChanges(
      changes(
        [
          { kind: "list", entityId: "l1", label: "Main navigation", detail: "main-nav" },
          { kind: "layout", entityId: "s1", label: "Layout chrome", detail: "block=header" },
          { kind: "module", entityId: "m1", label: "Pricing table", detail: "pricing-table" },
          {
            kind: "pluginRow",
            entityId: "r1",
            label: "international-site · translations",
            detail: "3f2a9c1e",
          },
          {
            kind: "page",
            entityId: PRICING,
            label: "Pricing",
            pageId: PRICING,
            pagePath: "/pricing",
          },
        ],
        // An isolated chat's marked-staged ref is still not on staging.
        [{ kind: "module", entityId: "m1", label: "Pricing table" }],
      ),
      new Map([["module:m1", many(["/pricing", "/enterprise", "/teams"])]]),
    );
    expect(s.siteWide).toBe(4);
    expect(s.rows.map((r) => `${r.area}:${r.title}:${r.what}`)).toEqual([
      "page:Pricing:Page settings",
      "siteWide:Pricing table:Section design · on 3 pages",
      "siteWide:Header:Site layout",
      "siteWide:Main navigation:List",
      "siteWide:international-site:Plugin data",
    ]);
  });

  it("counts a section's content shown on one page as a change of that page", () => {
    // Every placement holds its own content instance: editing one section's
    // text is a content-instance change, which the operator sees as a page change.
    const refs: Ref[] = [
      { kind: "contentInstance", entityId: "ci1", label: "Hero", detail: "hero" },
      { kind: "contentInstance", entityId: "ci2", label: "Tile", detail: "tile" },
    ];
    const s = summarizeDraftChanges(
      changes(refs),
      new Map<string, PartWhere>([
        ["contentInstance:ci1", { kind: "page", page: page("/pricing", PRICING) }],
        ["contentInstance:ci2", { kind: "page", page: page("/pricing", PRICING) }],
      ]),
    );
    expect(s).toEqual({
      newPages: 0,
      changedPages: 1,
      removedPages: 0,
      siteWide: 0,
      rows: [
        {
          key: `page:${PRICING}`,
          area: "page",
          change: "changed",
          title: "Title of /pricing",
          path: "/pricing",
          what: "Text and images",
          pageId: PRICING,
        },
      ],
    });
  });

  it("folds a section design made for a new page into that page", () => {
    const s = summarizeDraftChanges(
      changes([
        {
          kind: "page",
          entityId: NEWPAGE,
          label: "Domain check",
          pageId: NEWPAGE,
          pagePath: "/domain-check",
          change: "created",
        },
        { kind: "module", entityId: "m1", label: "Domain check form" },
      ]),
      new Map<string, PartWhere>([
        ["module:m1", { kind: "page", page: page("/domain-check", NEWPAGE) }],
      ]),
    );
    expect([s.newPages, s.siteWide]).toEqual([1, 0]);
    expect(s.rows.map((r) => [r.change, r.title, r.what])).toEqual([
      ["new", "Domain check", "New page"],
    ]);
  });

  it("leaves out a part no page shows and says where a shared one shows", () => {
    const s = summarizeDraftChanges(
      changes([
        { kind: "module", entityId: "m1", label: "Unused teaser" },
        { kind: "contentInstance", entityId: "ci1", label: "FAQ: data access" },
        { kind: "contentInstance", entityId: "ci2", label: "Footer links" },
      ]),
      new Map<string, PartWhere>([
        ["module:m1", { kind: "nowhere" }],
        ["contentInstance:ci1", many(["/a", "/b"])],
        [
          "contentInstance:ci2",
          { kind: "many", pages: [], morePages: false, inLayout: true, lists: [] },
        ],
      ]),
    );
    expect(s.rows.map((r) => `${r.title}:${r.what}`)).toEqual([
      "FAQ: data access:Shared content · on 2 pages",
      "Footer links:Shared content · in the site layout",
    ]);
  });

  it("refuses a section design or content whose placement was not read", () => {
    const refs: Ref[] = [{ kind: "contentInstance", entityId: "ci1", label: "Hero" }];
    expect(placedPartsOf(changes(refs))).toEqual([{ kind: "contentInstance", id: "ci1" }]);
    expect(() => summarizeDraftChanges(changes(refs), NONE)).toThrow(/no placement/);
  });
});
