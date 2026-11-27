// SPDX-License-Identifier: MPL-2.0

/**
 * #1753 — what a plugin may add to a page's JSON-LD graph (the
 * `structured_data` composition point, epic #1751), for every plugin,
 * shipped or installed.
 *
 * Core writes one `<script type="application/ld+json">` per page holding
 * one `@graph` whose core nodes have fixed `@id`s: the Organization
 * (`<site>/#organization`), the WebSite (`<site>/#website`), the WebPage
 * (`<page URL>`) and the BreadcrumbList (`<page URL>#breadcrumb`). A plugin
 * answers per page with typed nodes and a few WebPage properties; core
 * checks every part, builds every URL and `@id` itself and serializes the
 * graph (CLAUDE.md §2: no raw HTML into `<head>`, core serializes what
 * reaches a page). One owner per `@id`: a plugin cannot mint a core node's
 * id or one another plugin already holds.
 *
 * Values are typed, never free JSON:
 *
 * - a string is text: at most {@link STRUCTURED_DATA_TEXT_MAX} characters,
 *   never markup (`<p>`, `</script>`), never a URL (`https://…`);
 * - a number (finite) or a boolean;
 * - `{date}`: `YYYY-MM-DD` or an ISO 8601 date-time with its offset;
 * - `{duration}`: an ISO 8601 duration (`PT4M13S`);
 * - `{live: "published" | "modified"}`: the date the page went live first
 *   or last changed live, from the live page record (`dateModified` agrees
 *   with the sitemap's `<lastmod>`); a page outside the record has no such
 *   date and the property is left out;
 * - `{page: <page id>}`: that page's public URL, built by core;
 * - `{media: <media id>}`: the URL of that library image, published by core;
 * - `{url: "https://…"}`: an address on ANOTHER site (a profile on a social
 *   network, a video host); an address of this site is a page or media id;
 * - `{schema: "InStock"}`: a schema.org term (`https://schema.org/InStock`);
 * - `{ref: …}`: an `@id` reference — `"organization"`, `"website"`,
 *   `"webpage"`, `"breadcrumb"` (the core nodes), `{fragment}` (a node of
 *   this page: `<page URL>#<fragment>`) or `{page, fragment}` (a node named
 *   after another page: an author's Person is `<author page URL>#person`).
 *   Every reference must name a node of the same graph;
 * - `{node: {type, properties}}`: a nested node without `@id` (an address,
 *   an offer, an image object), at most {@link STRUCTURED_DATA_INLINE_DEPTH}
 *   deep;
 * - an array of the above (no arrays in arrays), at most
 *   {@link STRUCTURED_DATA_ARRAY_MAX} entries, kept in order.
 *
 * `@type` must be a schema.org type core knows (`SCHEMA_ORG_TYPES` in
 * `@caelo-cms/shared`); a WebPage type only one of {@link WEB_PAGE_TYPES}.
 *
 * Anything else is refused and named:
 * `plugin-value-refused:<plugin>.structured-data.<field>:<rule>`, a render
 * failure the editor preview lists, a Stage records and Publish live
 * refuses. A refused part is left out of the graph; it never reaches a page
 * unchecked.
 */

/** Nodes one plugin may add to one page's graph. */
export const STRUCTURED_DATA_NODES_PER_PAGE = 32;

/** The largest answer for one page, serialized as the plugin wrote it. */
export const STRUCTURED_DATA_PAGE_MAX_BYTES = 16 * 1024;

/** The largest answer of one call, serialized. */
export const STRUCTURED_DATA_ANSWER_MAX_BYTES = 1024 * 1024;

/** Pages one call is asked about: at the page cap the answer stays under the call cap. */
export const STRUCTURED_DATA_PAGES_PER_CALL = 50;

/** Characters of one text value. */
export const STRUCTURED_DATA_TEXT_MAX = 5000;

/** Entries of one array value. */
export const STRUCTURED_DATA_ARRAY_MAX = 50;

/** Properties of one node. */
export const STRUCTURED_DATA_PROPERTIES_PER_NODE = 40;

/** How deep `{node}` values may nest inside a node. */
export const STRUCTURED_DATA_INLINE_DEPTH = 3;

/** The core nodes a `{ref}` may name by name. */
export const CORE_NODE_REFS = ["organization", "website", "webpage", "breadcrumb"] as const;

/** A core node a `{ref}` names. */
export type CoreNodeRef = (typeof CORE_NODE_REFS)[number];

/**
 * The `@id` fragments core keeps for itself: a plugin node may not be
 * named `<page URL>#organization` even on the home page, whose URL is the
 * site's.
 */
export const RESERVED_NODE_FRAGMENTS: readonly string[] = [...CORE_NODE_REFS];

/** The pattern of a node fragment (`person`, `article`, `item-list`). */
export const NODE_FRAGMENT_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** The WebPage types a plugin may give a page (core's node keeps its `@id`). */
export const WEB_PAGE_TYPES = [
  "WebPage",
  "AboutPage",
  "CheckoutPage",
  "CollectionPage",
  "ContactPage",
  "FAQPage",
  "ItemPage",
  "MedicalWebPage",
  "ProfilePage",
  "QAPage",
  "RealEstateListing",
  "SearchResultsPage",
] as const;

/** A WebPage type a plugin may give a page. */
export type WebPageType = (typeof WEB_PAGE_TYPES)[number];

/**
 * The WebPage properties a plugin may set. Everything else on the node is
 * core's: `name`, `url`, `description`, `image`, `inLanguage`, `isPartOf`,
 * `breadcrumb`, `publisher`, `datePublished`, `dateModified`.
 */
export const WEB_PAGE_PROPERTIES = [
  "reviewedBy",
  "lastReviewed",
  "about",
  "mainEntity",
  "primaryImageOfPage",
  "significantLink",
  "relatedLink",
  "specialty",
  "keywords",
  "mentions",
  "audience",
] as const;

/** A WebPage property a plugin may set. */
export type WebPageProperty = (typeof WEB_PAGE_PROPERTIES)[number];

/** An `@id` reference: a core node, a node of this page, or one named after another page. */
export type StructuredDataRef =
  | CoreNodeRef
  | { readonly fragment: string }
  | { readonly page: string; readonly fragment: string };

/** One value of a node property (see the file comment). */
export type StructuredDataScalar =
  | string
  | number
  | boolean
  | { readonly date: string }
  | { readonly duration: string }
  | { readonly live: "published" | "modified" }
  | { readonly page: string }
  | { readonly media: string }
  | { readonly url: string }
  | { readonly schema: string }
  | { readonly ref: StructuredDataRef }
  | { readonly node: StructuredDataInlineNode };

/** A property value: one scalar or an array of them. */
export type StructuredDataValue = StructuredDataScalar | readonly StructuredDataScalar[];

/** A node without `@id`, nested in another (`PostalAddress`, `Offer`, `ImageObject`). */
export interface StructuredDataInlineNode {
  /** A schema.org type, or up to three (`["Organization", "Brand"]`). */
  readonly type: string | readonly string[];
  readonly properties: Readonly<Record<string, StructuredDataValue>>;
}

/** A node of the page's graph, named so others can reference it. */
export interface StructuredDataNode extends StructuredDataInlineNode {
  /** `{fragment}` → `<page URL>#<fragment>`; `{page, fragment}` → `<that page's URL>#<fragment>`. */
  readonly id: { readonly fragment: string; readonly page?: string };
}

/** One page's answer. */
export interface StructuredDataPageAnswer {
  /** The WebPage node core writes for the page: a subtype and allowlisted properties. */
  readonly webPage?: {
    readonly type?: WebPageType;
    readonly properties?: Partial<Readonly<Record<WebPageProperty, StructuredDataValue>>>;
  };
  readonly nodes?: readonly StructuredDataNode[];
}

/** What a structured-data operation returns: pages it has nothing for are absent. */
export interface StructuredDataAnswer {
  readonly pages: Readonly<Record<string, StructuredDataPageAnswer>>;
}

/** A vocabulary entry a page carries. */
export interface StructuredDataTerm {
  /** The vocabulary list's slug (`tags`, `categories`). */
  readonly vocabulary: string;
  readonly listId: string;
  readonly itemId: string;
  readonly name: string;
  readonly slug: string;
  /** The term's overview page (`landing_page`), or null: a term without one has no URL. */
  readonly overviewPageId: string | null;
}

/**
 * What core tells a plugin about one page: only what the page shows or
 * core owns, so the markup can match the visible text.
 */
export interface StructuredDataPage {
  readonly pageId: string;
  /** The page type's slug. */
  readonly pageType: string;
  /** The page's composed path (`/blog/anna`). */
  readonly path: string;
  readonly isHome: boolean;
  /** The page's document language (`<html lang>`). */
  readonly lang: string;
  readonly title: string;
  readonly shortTitle: string;
  /** The meta description the page renders ("" when none). */
  readonly description: string;
  /** The share image the page renders, or null. */
  readonly shareImage: string | null;
  /** Whether the page has the live dates `{live: …}` names in this render. */
  readonly live: boolean;
  /**
   * When the page went live first (ISO 8601, the live page record), or null
   * when it never has: what a news sitemap's two-day window is measured on.
   */
  readonly publishedAt: string | null;
  /**
   * The page's properties as stored: a `page` property as
   * `caelo:page/<id>` references, a `media` one as `caelo:media/<id>`, a
   * `link` as `{href}`, a `date` as `YYYY-MM-DD`.
   */
  readonly properties: Readonly<Record<string, unknown>>;
  readonly terms: readonly StructuredDataTerm[];
  /**
   * The pages the page's lists show, in the order shown (an overview's
   * current page of results, an author page's articles): what an ItemList
   * of the page may name.
   */
  readonly listed: readonly string[];
}

/** One property of a page type, as the plugin needs it to read values. */
export interface StructuredDataPropertyDef {
  readonly name: string;
  /** The field type (`text`, `page`, `media`, `date`, `link`, …). */
  readonly type: string;
  readonly multiple?: boolean;
}

/** What a structured-data operation is called with. */
export interface StructuredDataArgs {
  /** The pages to answer for (at most {@link STRUCTURED_DATA_PAGES_PER_CALL}). */
  readonly pages: readonly StructuredDataPage[];
  /**
   * The pages the asked pages name through `page` properties and the
   * overview pages of their terms, one level deep: an article's authors,
   * its reviewer. Published pages only (a draft author is left out, as on
   * the page). Not to be answered for; they carry no head of their own
   * here (`description` "", `shareImage` null, `lang` "", `live` false,
   * `listed` empty): what the page about them says comes from their
   * properties.
   */
  readonly related: readonly StructuredDataPage[];
  /** The page types of every page above, by slug. */
  readonly pageTypes: Readonly<
    Record<string, { readonly properties: readonly StructuredDataPropertyDef[] }>
  >;
  /** What the site's core nodes are: a `{ref: "organization"}` needs the Organization. */
  readonly site: {
    /** The site has an Organization node (`<site>/#organization`). */
    readonly organization: boolean;
    /** The site's name (`site_defaults.site_name`), null when it has none. */
    readonly name: string | null;
  };
}
