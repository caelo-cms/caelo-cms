// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { summarizeDraftChanges } from "./draft-summary.js";
import type { PendingChanges } from "./stage.js";

type Ref = PendingChanges["pending"]["pages"][number];

function changes(pending: Ref[], staged: Ref[] = []): PendingChanges {
  const split = (refs: Ref[]) => ({
    pages: refs.filter((r) => ["page", "pageLayout", "pageModuleContent"].includes(r.kind)),
    globals: refs.filter((r) => !["page", "pageLayout", "pageModuleContent", "list"].includes(r.kind)),
    lists: refs.filter((r) => r.kind === "list"),
  });
  return { pending: split(pending), staged: split(staged) };
}

const PRICING = "11111111-1111-4111-8111-111111111111";
const NEWPAGE = "22222222-2222-4222-8222-222222222222";
const GONE = "33333333-3333-4333-8333-333333333333";

describe("summarizeDraftChanges", () => {
  it("counts a page once however many of its parts changed", () => {
    const s = summarizeDraftChanges(
      changes([
        { kind: "pageModuleContent", entityId: "c1", label: "Pricing", pageId: PRICING, pagePath: "/pricing" },
        { kind: "pageModuleContent", entityId: "c2", label: "Pricing", pageId: PRICING, pagePath: "/pricing" },
        { kind: "pageLayout", entityId: PRICING, label: "Pricing", pageId: PRICING, pagePath: "/pricing" },
      ]),
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
        { kind: "page", entityId: NEWPAGE, label: "Enterprise", pageId: NEWPAGE, pagePath: "/enterprise", change: "created" },
        { kind: "pageLayout", entityId: NEWPAGE, label: "Enterprise", pageId: NEWPAGE, pagePath: "/enterprise" },
        { kind: "page", entityId: GONE, label: "Old partners", pageId: GONE, pagePath: "/old-partners", change: "deleted" },
        { kind: "page", entityId: PRICING, label: "Pricing", pageId: PRICING, pagePath: "/pricing", seo: true },
      ]),
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
        { kind: "page", entityId: NEWPAGE, label: "Scratch", pageId: NEWPAGE, change: "createdAndDeleted" },
        { kind: "pageLayout", entityId: NEWPAGE, label: "Scratch", pageId: NEWPAGE },
      ]),
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
          { kind: "pluginRow", entityId: "r1", label: "international-site · translations", detail: "3f2a9c1e" },
          { kind: "page", entityId: PRICING, label: "Pricing", pageId: PRICING, pagePath: "/pricing" },
        ],
        // An isolated chat's marked-staged ref is still not on staging.
        [{ kind: "module", entityId: "m1", label: "Pricing table" }],
      ),
    );
    expect(s.siteWide).toBe(4);
    expect(s.rows.map((r) => `${r.area}:${r.title}:${r.what}`)).toEqual([
      "page:Pricing:Page settings",
      "siteWide:Pricing table:Section design",
      "siteWide:Header:Site layout",
      "siteWide:Main navigation:List",
      "siteWide:international-site:Plugin data",
    ]);
  });
});
