// SPDX-License-Identifier: MPL-2.0

/**
 * Shared fixture data for the list rendering tests (epic #1107). A
 * `.test.ts` file so it never ships in `dist`; it declares no tests of
 * its own.
 *
 * The site: a home page, About (with Team below it), a News section
 * with two published news pages and one draft, a header menu, a mega
 * menu (entry → column / news feed / promo → sub link), a tag
 * vocabulary and an image.
 */

import { createSiteLinkIndex, type LinkPageVariant } from "../link-refs.js";
import { DEFAULT_LIST_TYPES, SITE_TEXTS_TYPE } from "./default-types.js";
import type { ListItem } from "./items.js";
import type { ListTypeDef } from "./list-type.js";
import type {
  ListPageRecord,
  ListRenderData,
  ListVariantOverlay,
  LoadedList,
} from "./render-data.js";

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const PAGE = {
  home: id(1),
  about: id(2),
  team: id(3),
  news: id(4),
  newsA: id(5),
  newsB: id(6),
  newsDraft: id(7),
} as const;

export const LIST = { header: id(101), mega: id(102), tags: id(103) } as const;

export const ITEM = {
  home: id(201),
  about: id(202),
  team: id(203),
  newsEntry: id(204),
  products: id(205),
  column: id(206),
  subA: id(207),
  subB: id(208),
  feed: id(209),
  promo: id(210),
  tagRelease: id(211),
  tagEvent: id(212),
} as const;

export const MODULE = { teaser: id(301) } as const;
export const INSTANCE = { teaser: id(401), placement: id(402) } as const;
export const MEDIA = { hero: id(501) } as const;

const termRef = (item: string): string => `caelo:term/${LIST.tags}/${item}`;
export const TERM = { release: termRef(ITEM.tagRelease), event: termRef(ITEM.tagEvent) };

/** A mega menu: entries with columns of links, a "latest news" feed and a promo teaser module. */
export const MEGA_MENU_TYPE: ListTypeDef = {
  slug: "mega-menu",
  name: "Mega menu",
  purpose: "Header navigation with dropdown columns, a news feed and a promo.",
  role: "navigation",
  root: { allow: ["entry"] },
  nodes: {
    entry: {
      label: "Entry",
      fields: [
        { name: "label", label: "Label", type: "text", required: true },
        { name: "link", label: "Link", type: "link" },
      ],
      children: { name: "columns", allow: ["column", "news_feed", "promo"] },
      current_from: "link",
    },
    column: {
      label: "Column",
      fields: [{ name: "heading", label: "Heading", type: "text" }],
      children: { name: "links", allow: ["sub_link"] },
    },
    sub_link: {
      label: "Link",
      fields: [
        { name: "label", label: "Label", type: "text", required: true },
        { name: "link", label: "Link", type: "link", required: true },
        { name: "badge", label: "Badge", type: "select", options: ["new", "hot"] },
      ],
      current_from: "link",
    },
    news_feed: {
      label: "Latest news",
      fields: [{ name: "heading", label: "Heading", type: "text" }],
      source: {
        kind: "query",
        editable: ["limit", "terms"],
        defaults: { page_type: "news", order: "published_desc", limit: 3 },
      },
    },
    promo: {
      label: "Promo",
      fields: [
        { name: "title", label: "Title", type: "text" },
        { name: "teaser", label: "Teaser", type: "module" },
      ],
    },
  },
  max_depth: 3,
};

const page = (
  pageId: string,
  title: string,
  extra: Partial<ListPageRecord> = {},
): ListPageRecord => ({
  id: pageId,
  title,
  shortTitle: title,
  parentId: null,
  pageTypeSlug: "page",
  properties: {},
  terms: [],
  firstPublishedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  summary: null,
  image: null,
  inBuild: true,
  ...extra,
});

export const PAGES: readonly ListPageRecord[] = [
  page(PAGE.home, "Home"),
  page(PAGE.about, "About"),
  page(PAGE.team, "Team", { parentId: PAGE.about }),
  page(PAGE.news, "News"),
  page(PAGE.newsA, "Launch day", {
    parentId: PAGE.news,
    pageTypeSlug: "news",
    terms: [TERM.release],
    firstPublishedAt: "2026-10-01T09:00:00.000Z",
    properties: { rating: 4, event_date: "2026-11-02" },
    summary: "We launched.",
    image: `caelo:media/${MEDIA.hero}`,
  }),
  page(PAGE.newsB, "Meetup", {
    parentId: PAGE.news,
    pageTypeSlug: "news",
    terms: [TERM.event],
    firstPublishedAt: "2026-10-05T09:00:00.000Z",
    properties: { rating: 5 },
  }),
  page(PAGE.newsDraft, "Draft post", {
    parentId: PAGE.news,
    pageTypeSlug: "news",
    firstPublishedAt: null,
    inBuild: false,
  }),
];

const entry = (
  itemId: string,
  node: string,
  values: Record<string, unknown>,
  extra: Partial<ListItem> = {},
): ListItem => ({ id: itemId, node, values, ...extra });

export const HEADER_ITEMS: readonly ListItem[] = [
  entry(ITEM.home, "entry", { label: "Home", link: { href: `caelo:page/${PAGE.home}` } }),
  entry(
    ITEM.about,
    "entry",
    { label: "About", link: { href: `caelo:page/${PAGE.about}` } },
    {
      children: [
        entry(ITEM.team, "entry", { label: "Team", link: { href: `caelo:page/${PAGE.team}` } }),
      ],
    },
  ),
  entry(ITEM.newsEntry, "entry", { label: "News", link: { href: `caelo:page/${PAGE.news}` } }),
];

export const MEGA_ITEMS: readonly ListItem[] = [
  entry(
    ITEM.products,
    "entry",
    { label: "Products", link: { href: `caelo:page/${PAGE.about}` } },
    {
      children: [
        entry(
          ITEM.column,
          "column",
          { heading: "Explore" },
          {
            children: [
              entry(ITEM.subA, "sub_link", {
                label: "Team",
                link: { href: `caelo:page/${PAGE.team}` },
                badge: "new",
              }),
              entry(ITEM.subB, "sub_link", {
                label: "Docs",
                link: { href: "https://docs.example" },
              }),
            ],
          },
        ),
        entry(ITEM.feed, "news_feed", { heading: "Latest" }, { query: { limit: 2 } }),
        entry(ITEM.promo, "promo", {
          title: "Try it",
          teaser: { moduleId: MODULE.teaser, contentInstanceId: INSTANCE.teaser },
        }),
      ],
    },
  ),
];

const list = (
  listId: string,
  slug: string,
  typeSlug: string,
  items: readonly ListItem[],
): LoadedList => ({
  id: listId,
  slug,
  name: slug,
  typeSlug,
  items,
});

export const LISTS: readonly LoadedList[] = [
  list(LIST.header, "header", "menu", HEADER_ITEMS),
  list(LIST.mega, "mega", "mega-menu", MEGA_ITEMS),
  list(LIST.tags, "tags", "tags", [
    entry(ITEM.tagRelease, "tag", { name: "Release", slug: "release" }),
    entry(ITEM.tagEvent, "tag", { name: "Event", slug: "event" }),
  ]),
];

/** The render data of the fixture site; `overlays` / `pageVariants` per test. */
export function fixtureData(
  extra: {
    overlays?: ReadonlyMap<string, ListVariantOverlay>;
    pageVariants?: ReadonlyMap<string, LinkPageVariant>;
    pages?: readonly ListPageRecord[];
    /** Default: the fixture home page. */
    homePageId?: string | null;
    /** Shared lists added to the fixture ones (e.g. a site texts list). */
    lists?: readonly LoadedList[];
  } = {},
): ListRenderData {
  const types = [...DEFAULT_LIST_TYPES, MEGA_MENU_TYPE, SITE_TEXTS_TYPE];
  return {
    listTypes: new Map(types.map((t, i) => [t.slug, { id: id(600 + i), def: t }])),
    lists: new Map([...LISTS, ...(extra.lists ?? [])].map((l) => [l.id, l])),
    pageTypes: new Map([
      [
        "news",
        {
          id: id(701),
          def: {
            slug: "news",
            name: "News",
            purpose: "News posts.",
            collection: true,
            templates: [id(801)],
            defaultTemplate: id(801),
            properties: [
              { name: "rating", label: "Rating", type: "number" },
              { name: "event_date", label: "Event date", type: "date" },
            ],
            vocabularies: [{ list: LIST.tags, cardinality: "many" }],
          },
        },
      ],
    ]),
    pages: new Map((extra.pages ?? PAGES).map((p) => [p.id, p])),
    media: new Map([[MEDIA.hero, { id: MEDIA.hero, alt: "Hero", width: 1200, height: 600 }]]),
    ...(extra.pageVariants ? { pageVariants: extra.pageVariants } : {}),
    ...(extra.overlays ? { overlays: extra.overlays } : {}),
    siteLanguage: "en",
    homePageId: extra.homePageId === undefined ? PAGE.home : extra.homePageId,
  };
}

const PATHS: Record<string, string> = {
  [PAGE.home]: "/",
  [PAGE.about]: "/about",
  [PAGE.team]: "/about/team",
  [PAGE.news]: "/news",
  [PAGE.newsA]: "/news/launch",
  [PAGE.newsB]: "/news/meetup",
  [PAGE.newsDraft]: "/news/draft",
};

/** A link index over the fixture pages (preview env, directory URLs). */
export function fixtureLinkIndex(pageVariants?: ReadonlyMap<string, LinkPageVariant>) {
  return createSiteLinkIndex({
    pages: PAGES.map((p) => ({
      id: p.id,
      path: PATHS[p.id] ?? "/",
      status: p.inBuild ? "published" : "draft",
    })),
    media: [{ id: MEDIA.hero, slug: "hero" }],
    env: "preview",
    pageUrlStyle: "directory",
    ...(pageVariants ? { pageVariants } : {}),
  });
}
