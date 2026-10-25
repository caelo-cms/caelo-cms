// SPDX-License-Identifier: MPL-2.0

/**
 * What a render needs to resolve lists, loaded in one batch per preview
 * or per build (epic #1107, `docs/lists.md` §10). The admin side builds it
 * (`admin-core/src/lists/load.ts`: draft overlay in previews, published
 * state in builds); the shared resolver (`resolve.ts`) consumes it. After
 * loading, everything is pure and synchronous — the same split as
 * `SiteLinkIndex` for links.
 */

import type { LinkPageVariant } from "../link-refs.js";
import type { ListItem } from "./items.js";
import type { ListTypeDef } from "./list-type.js";
import type { PageTypeDef } from "./page-type.js";

/** A list type as loaded (draft view in previews). */
export interface LoadedListType {
  readonly id: string;
  readonly def: ListTypeDef;
}

/** A shared list as loaded. */
export interface LoadedList {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly typeSlug: string;
  readonly items: readonly ListItem[];
}

/** A page type as loaded. */
export interface LoadedPageType {
  readonly id: string;
  readonly def: PageTypeDef;
}

/**
 * One page as queries, system sources and `{{page.*}}` see it. Every
 * live page of the render's scope is listed; `inBuild` says whether a
 * query may return it (published in this build; in previews: status
 * published in the draft view).
 */
export interface ListPageRecord {
  readonly id: string;
  readonly title: string;
  readonly parentId: string | null;
  readonly pageTypeSlug: string;
  readonly properties: Readonly<Record<string, unknown>>;
  /** `caelo:term/<listId>/<itemId>` */
  readonly terms: readonly string[];
  /** ISO timestamp, null until the first Publish live. */
  readonly firstPublishedAt: string | null;
  readonly updatedAt: string;
  /** SEO meta description, or null. */
  readonly summary: string | null;
  /** `caelo:media/<id>` social image, or null. */
  readonly image: string | null;
  readonly inBuild: boolean;
}

/** Media metadata for `{{f.alt}}`, `{{f.width}}`, `{{f.height}}`. URLs come from the link resolver. */
export interface ListMediaRecord {
  readonly id: string;
  readonly alt: string | null;
  readonly width: number | null;
  readonly height: number | null;
}

/**
 * A plugin's `list-resolve` answer for one output variant. Keys are
 * value addresses (`address.ts`). An overlay may replace values and hide
 * entries; it can never add, remove or reorder entries.
 */
export interface ListVariantOverlay {
  readonly values: ReadonlyMap<string, unknown>;
  /** Addresses of hidden entries: `list/<listId>/item/<itemId>` or `instance/<id>/<field>/item/<itemId>`. */
  readonly hidden: ReadonlySet<string>;
}

/** An entry a plugin list source produced for one page. Values follow the source's node definition. */
export interface PluginSourceEntry {
  readonly id: string;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface ListRenderData {
  /** Keyed by list type slug. */
  readonly listTypes: ReadonlyMap<string, LoadedListType>;
  /** Keyed by list id. */
  readonly lists: ReadonlyMap<string, LoadedList>;
  /** Keyed by page type slug. */
  readonly pageTypes: ReadonlyMap<string, LoadedPageType>;
  /** Keyed by page id. */
  readonly pages: ReadonlyMap<string, ListPageRecord>;
  /** Keyed by media id. */
  readonly media: ReadonlyMap<string, ListMediaRecord>;
  /** The `link-resolve` page partition (same map the link index uses). */
  readonly pageVariants?: ReadonlyMap<string, LinkPageVariant>;
  /** `list-resolve` overlays keyed by variant. */
  readonly overlays?: ReadonlyMap<string, ListVariantOverlay>;
  /** `site_settings.site_language`, for `{{date.formatted}}`. */
  readonly siteLanguage: string;
}

/** Render dependencies one page collected (build manifest `render-deps.json`). */
export interface ListRenderDeps {
  readonly lists: readonly string[];
  readonly listTypes: readonly string[];
  /** Normalised query filters (page type, terms, parent) the page rendered. */
  readonly queries: readonly {
    readonly pageType: string | null;
    readonly terms: readonly string[];
    readonly parent: string | null;
  }[];
  /** System sources that depend on the page tree (breadcrumbs, children, siblings, term_pages). */
  readonly pageTree: boolean;
}
