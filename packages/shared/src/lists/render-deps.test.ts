// SPDX-License-Identifier: MPL-2.0

/**
 * Incremental build selection over `render-deps.json` (epic #1107,
 * `docs/lists.md` §10): exactly the pages a change reaches.
 */

import { describe, expect, it } from "bun:test";
import { PAGE, PAGES, TERM } from "./list-fixtures.test.js";
import type { ListRenderDeps } from "./render-data.js";
import {
  mergeRenderDeps,
  parseRenderDeps,
  type RenderDepsPageAttrs,
  renderDepsAttrs,
  selectDependentPages,
} from "./render-deps.js";

const NONE: ListRenderDeps = { lists: [], listTypes: [], queries: [], pageTree: false, pages: [] };
const LIST_A = "00000000-0000-4000-8000-00000000aaaa";

const deps = mergeRenderDeps(
  null,
  new Map<string, ListRenderDeps>([
    // The home page shows the header menu and "latest news".
    [
      PAGE.home,
      {
        ...NONE,
        lists: [LIST_A],
        listTypes: ["menu"],
        queries: [{ pageType: "news", terms: [], parent: null }],
      },
    ],
    // About shows breadcrumbs.
    [PAGE.about, { ...NONE, pageTree: true }],
    // Team shows "related: events".
    [PAGE.team, { ...NONE, queries: [{ pageType: null, terms: [TERM.event], parent: null }] }],
    [PAGE.news, NONE],
  ]),
  PAGES,
);
const current = (patch: Partial<Record<string, Partial<RenderDepsPageAttrs>>> = {}) =>
  new Map(PAGES.map((p) => [p.id, { ...renderDepsAttrs(p), ...(patch[p.id] ?? {}) }] as const));

describe("selectDependentPages", () => {
  it("a changed list rebuilds the pages that read it", () => {
    const got = selectDependentPages(
      deps,
      { pageIds: [], listIds: [LIST_A], listTypeSlugs: [] },
      current(),
    );
    expect([...got]).toEqual([PAGE.home]);
  });

  it("a changed list type rebuilds the pages that read lists of it", () => {
    const got = selectDependentPages(
      deps,
      { pageIds: [], listIds: [], listTypeSlugs: ["menu"] },
      current(),
    );
    expect([...got]).toEqual([PAGE.home]);
  });

  it("publishing a News page rebuilds exactly the pages whose query matches it", () => {
    // The draft enters the build: it now matches "latest news" (home);
    // its title / build membership change hits the page-tree reader (about).
    const got = selectDependentPages(
      deps,
      { pageIds: [PAGE.newsDraft], listIds: [], listTypeSlugs: [] },
      current({ [PAGE.newsDraft]: { inBuild: true } }),
    );
    expect([...got].sort()).toEqual([PAGE.home, PAGE.about].sort());
  });

  it("a page that LEFT a filter reaches the pages that rendered it", () => {
    // Meetup loses the "event" term: Team's related query showed it before.
    const got = selectDependentPages(
      deps,
      { pageIds: [PAGE.newsB], listIds: [], listTypeSlugs: [] },
      current({ [PAGE.newsB]: { terms: [] } }),
    );
    expect(got.has(PAGE.team)).toBe(true);
    expect(got.has(PAGE.home)).toBe(true);
    expect(got.has(PAGE.about)).toBe(false);
  });

  it("a content edit that changes no filter attribute reaches no page-tree reader", () => {
    const got = selectDependentPages(
      deps,
      { pageIds: [PAGE.home], listIds: [], listTypeSlugs: [] },
      current(),
    );
    expect(got.size).toBe(0);
  });
});

describe("render-deps.json", () => {
  it("a property-only edit of a page a system source rendered rebuilds that reader (#1121 review)", () => {
    // Team lists its children; News is one of them. Editing News' props
    // changes no tree attribute, but Team shows News' values.
    const withChildren = mergeRenderDeps(
      deps,
      new Map([[PAGE.team, { ...NONE, pageTree: true, pages: [PAGE.news] }]]),
      PAGES,
    );
    const got = selectDependentPages(
      withChildren,
      { pageIds: [PAGE.news], listIds: [], listTypeSlugs: [] },
      current(),
    );
    expect(got.has(PAGE.team)).toBe(true);
    expect(got.has(PAGE.about)).toBe(false);
  });

  it("round-trips and merges an incremental build into the previous file", () => {
    const parsed = parseRenderDeps(JSON.stringify(deps));
    expect(parsed).toEqual(deps);
    const merged = mergeRenderDeps(
      parsed,
      new Map([[PAGE.news, { ...NONE, pageTree: true }]]),
      PAGES,
    );
    expect(merged.pages[PAGE.news]?.pageTree).toBe(true);
    expect(merged.pages[PAGE.home]).toEqual(deps.pages[PAGE.home] as ListRenderDeps);
  });

  it("an unknown version reads as no deps (a full build follows)", () => {
    expect(parseRenderDeps(JSON.stringify({ version: 0, pages: {}, index: {} }))).toBeNull();
    expect(parseRenderDeps(null)).toBeNull();
  });
});
