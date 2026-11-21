// SPDX-License-Identifier: MPL-2.0

/**
 * The site's feed of its latest changes and the two pings that announce a
 * Publish live to search engines (docs/dev/search-engine-feed.md).
 *
 *  - `/feed.xml` — Atom 1.0: the {@link FEED_ENTRY_LIMIT} pages whose live
 *    content changed last, each with the date it changed. Search engines
 *    read a sitemap for the whole site and a feed for what is new; Google
 *    accepts both and recommends both.
 *  - WebSub — the feed names {@link WEBSUB_HUB_URL} as its hub; after a
 *    Publish live the admin tells the hub the feed changed, the hub fetches
 *    it and pushes it to its subscribers.
 *  - IndexNow — the admin submits the URLs a Publish live changed; every
 *    participating engine (Bing, Yandex, Seznam, Naver, Yep, …) shares one
 *    submission. Google does not take part. The site proves the host with a
 *    key file every build serves at `/<key>.txt`.
 *
 * A page's "change" is a change of what the page itself shows: its title,
 * its description and the text, links and images of its body. A header or
 * footer edit shown on every page is not a change of every page.
 */

import { z } from "zod";
import { trimSlashes } from "./url.js";

/** The feed's path at the site root. */
export const FEED_FILE = "feed.xml";

/** The served `Content-Type` of the feed. */
export const FEED_CONTENT_TYPE = "application/atom+xml; charset=utf-8";

/** Entries the feed carries: the pages changed last. The sitemap lists the rest. */
export const FEED_ENTRY_LIMIT = 100;

/** Google's public WebSub hub (pubsubhubbub.appspot.com, WebSub / PubSubHubbub 0.4). */
export const WEBSUB_HUB_URL = "https://pubsubhubbub.appspot.com/";

/** The shared IndexNow endpoint: one submission reaches every participating engine. */
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/** URLs IndexNow takes in one submission. */
export const INDEXNOW_MAX_URLS = 10_000;

/** The IndexNow key file a build serves for `key`, relative to the site root. */
export function indexNowKeyFile(key: string): string {
  return `${key}.txt`;
}

/** The absolute URL of the site's feed. */
export function siteFeedUrl(siteBaseUrl: string): string {
  return `${trimSlashes(siteBaseUrl)}/${FEED_FILE}`;
}

/**
 * The feed's title and author: the site as it is addressed, its host
 * (`www.example.com`). Always known — a build needs the base URL — so the
 * feed never waits for authoring data a site may not have (CLAUDE.md §2).
 */
export function siteFeedTitle(siteBaseUrl: string): string {
  return new URL(siteBaseUrl).host;
}

/** The feed every page of a site links, or null when the feed is off. */
export function siteFeedLink(
  feedEnabled: boolean,
  siteBaseUrl: string,
): { readonly url: string; readonly title: string } | null {
  return feedEnabled ? { url: siteFeedUrl(siteBaseUrl), title: siteFeedTitle(siteBaseUrl) } : null;
}

/**
 * How a page's live state changed (`live_page_versions.kind`):
 *  - `baseline` — what was live already when the feed shipped; recorded
 *    once, never announced (IndexNow asks not to submit old changes).
 *  - `added` — the page went live (first publication, published again,
 *    indexable again).
 *  - `changed` — what it shows changed.
 *  - `moved` — it is live at another URL (and maybe changed too).
 *  - `removed` — no longer live (unpublished, deleted, noindex).
 *  - `restored` — a rollback put an earlier state back (log only).
 *  - `redated` — the same content is served with another date: a rollback
 *    or a Publish live put back files that show it (log only, never
 *    announced: nothing changed live).
 */
export const PAGE_VERSION_KINDS = [
  "baseline",
  "added",
  "changed",
  "moved",
  "removed",
  "restored",
  "redated",
] as const;
export type PageVersionKind = (typeof PAGE_VERSION_KINDS)[number];

/** The kinds a build reports; `restored` is written by a rollback only. */
export const BUILD_CHANGE_KINDS = ["baseline", "added", "changed", "moved", "removed"] as const;
export type BuildChangeKind = (typeof BUILD_CHANGE_KINDS)[number];

/** Kinds announced to search engines: a change of what is live, not the baseline or a new date. */
export function isAnnouncedKind(kind: PageVersionKind): boolean {
  return kind !== "baseline" && kind !== "redated";
}

/** One page whose live state a build changes (or records as the baseline). */
export const pageChangeSchema = z
  .object({
    pageId: z.string().uuid(),
    kind: z.enum(BUILD_CHANGE_KINDS),
    /** Where the page is live after the build; null when it is removed. */
    url: z.string().max(2048).nullable(),
    /** sha256 hex of what the page shows; null when it is removed. */
    fingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    /**
     * sha256 hex of what the plugins baked into the page show (approved
     * comments, say); null when none bakes into it, or the page is removed.
     */
    pluginFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    /** The title and meta description it is published with; null when removed. */
    title: z.string().max(1000).nullable(),
    summary: z.string().max(2000).nullable(),
    /** Where it was live before; null when it was not. */
    prevUrl: z.string().max(2048).nullable(),
    /** The date the feed and the sitemap show for it (ISO). */
    changedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((c) => (c.url === null) === (c.fingerprint === null), "url and fingerprint go together")
  .refine((c) => (c.kind === "removed") === (c.url === null), "only a removed page has no url")
  .refine(
    (c) => c.url !== null || c.pluginFingerprint === null,
    "a removed page has no plugin fingerprint",
  )
  .refine(
    (c) => (c.url === null) === (c.title === null) && (c.url === null) === (c.summary === null),
    "a live page has a title and a summary, a removed one neither",
  );
export type PageChange = z.infer<typeof pageChangeSchema>;

/**
 * What a build reports about its feed and its pages
 * (`GenerateResult.searchFeed`), recorded with the run.
 */
export const buildSearchFeedSchema = z
  .object({
    /** The `live_page_versions` head the pages were compared against; null: the log was empty. */
    base: z.number().int().nonnegative().nullable(),
    /** The pages whose live state the build changes, plus the baseline. */
    changes: z.array(pageChangeSchema).max(500_000),
    /** The feed the build serves (absolute URL); null when the feed is off. */
    feedUrl: z.string().max(2048).nullable(),
    /** The IndexNow key file the build serves; null when IndexNow is off. */
    indexNowKey: z
      .string()
      .regex(/^[A-Za-z0-9-]{8,128}$/)
      .nullable(),
  })
  .strict();
export type BuildSearchFeed = z.infer<typeof buildSearchFeedSchema>;

/**
 * Can search engines reach `host`? False for names that only resolve inside
 * a network or on one machine (localhost, `.local`, `.internal`, the
 * reserved test names) and for IP literals: a ping for such a site would
 * only make the engine fetch an address it cannot reach.
 */
export function isPublicSiteHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h.length === 0 || !h.includes(".")) return false;
  if (h.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return false;
  const reserved = ["localhost", "local", "internal", "test", "example", "invalid", "home.arpa"];
  return !reserved.some((r) => h === r || h.endsWith(`.${r}`));
}
