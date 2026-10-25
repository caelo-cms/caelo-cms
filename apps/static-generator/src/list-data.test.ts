// SPDX-License-Identifier: MPL-2.0

/**
 * Incremental build selection in the generator (epic #1107): the changed
 * pages plus every page the recorded render deps say the change reaches.
 */

import { describe, expect, it } from "bun:test";
import { DEFAULT_LIST_TYPES, type ListRenderData, mergeRenderDeps } from "@caelo-cms/shared";
import { incrementalPageIds, isIncremental } from "./list-data.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HOME = id(1);
const NEWS_INDEX = id(2);
const POST = id(3);
const ABOUT = id(4);
const MENU = id(10);
const MENU_TYPE = id(20);

const page = (pageId: string, title: string, pageTypeSlug: string, inBuild = true) => ({
  id: pageId,
  title,
  parentId: null,
  pageTypeSlug,
  properties: {},
  terms: [],
  firstPublishedAt: null,
  updatedAt: "2026-10-01T00:00:00.000Z",
  summary: null,
  image: null,
  inBuild,
});

function data(postInBuild: boolean): ListRenderData {
  const pages = [
    page(HOME, "Home", "page"),
    page(NEWS_INDEX, "News", "page"),
    page(POST, "Launch", "news", postInBuild),
    page(ABOUT, "About", "page"),
  ];
  return {
    listTypes: new Map(
      DEFAULT_LIST_TYPES.map((t) => [
        t.slug,
        { id: t.slug === "menu" ? MENU_TYPE : t.slug, def: t },
      ]),
    ),
    lists: new Map(),
    pageTypes: new Map(),
    pages: new Map(pages.map((p) => [p.id, p])),
    media: new Map(),
    siteLanguage: "en",
  };
}

const NONE = { lists: [], listTypes: [], queries: [], pageTree: false };
// The last build: home shows the menu, the news index shows "latest news".
const deps = mergeRenderDeps(
  null,
  new Map([
    [HOME, { ...NONE, lists: [MENU], listTypes: ["menu"] }],
    [NEWS_INDEX, { ...NONE, queries: [{ pageType: "news", terms: [], parent: null }] }],
    [ABOUT, NONE],
  ]),
  data(false).pages.values(),
);

describe("incrementalPageIds", () => {
  it("publishing a News page rebuilds it and exactly the pages whose query shows it", () => {
    const ids = incrementalPageIds(
      { pageIds: [POST], listIds: [], listTypeIds: [] },
      deps,
      data(true),
    );
    expect(ids?.sort()).toEqual([POST, NEWS_INDEX].sort());
  });

  it("a changed menu list rebuilds the pages that render it", () => {
    expect(
      incrementalPageIds({ pageIds: [], listIds: [MENU], listTypeIds: [] }, deps, data(false)),
    ).toEqual([HOME]);
  });

  it("a changed list type maps to its slug", () => {
    expect(
      incrementalPageIds({ pageIds: [], listIds: [], listTypeIds: [MENU_TYPE] }, deps, data(false)),
    ).toEqual([HOME]);
  });

  it("without recorded deps a page change renders its pages, a list change every page", () => {
    expect(
      incrementalPageIds({ pageIds: [POST], listIds: [], listTypeIds: [] }, null, data(true)),
    ).toEqual([POST]);
    expect(
      incrementalPageIds({ pageIds: [], listIds: [MENU], listTypeIds: [] }, null, data(true)),
    ).toBeNull();
  });

  it("a build is incremental when anything is named as changed", () => {
    expect(isIncremental({ pageIds: [], listIds: [], listTypeIds: [] })).toBe(false);
    expect(isIncremental({ pageIds: [], listIds: [MENU], listTypeIds: [] })).toBe(true);
  });
});
