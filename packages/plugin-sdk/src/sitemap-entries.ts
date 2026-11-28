// SPDX-License-Identifier: MPL-2.0

/**
 * #1761 — what a plugin may add to the site's sitemaps (the
 * `sitemap_entries` composition point, epic #1751), for every plugin.
 *
 * Plugins own no routes and write no files: core writes every sitemap. A
 * plugin answers per page with typed entries of a closed set of sitemap
 * kinds, and core writes each kind into its own file next to
 * `sitemap.xml` and lists it in robots.txt:
 *
 * - `news` → `sitemap-news.xml` (Google News sitemap): the page is a news
 *   article. The plugin gives its `title`; core adds the publication (the
 *   site's name and the page's language) and the publication date from the
 *   live page record. The plugin decides which articles are recent enough
 *   (Google reads the last two days).
 * - `video` → `sitemap-video.xml` (video sitemap): the page's videos, each
 *   with a thumbnail (a library image, `{media}`), title, description and
 *   the video's address on another site (`contentUrl` or `playerUrl`,
 *   `{url}`), optionally its duration in seconds.
 *
 * Only pages core lists in `sitemap.xml` (indexable, published, not
 * excluded) reach these files; an entry for any other page is dropped by
 * core, not refused. Anything outside the vocabulary is refused and named
 * (`plugin-value-refused:<plugin>.sitemap-entries.<field>:<rule>`), a render
 * failure Publish live refuses.
 */

/** The sitemap kinds core writes, and each one's file. */
export const SITEMAP_KIND_FILES = {
  news: "sitemap-news.xml",
  video: "sitemap-video.xml",
} as const;

/** A sitemap kind a plugin may add entries to. */
export type SitemapKind = keyof typeof SITEMAP_KIND_FILES;

/** Videos one page may list. */
export const SITEMAP_VIDEOS_PER_PAGE = 5;

/** Characters of a news or video title. */
export const SITEMAP_TITLE_MAX = 300;

/** Characters of a video description (Google's limit). */
export const SITEMAP_DESCRIPTION_MAX = 2048;

/** The largest answer of one call, serialized. */
export const SITEMAP_ANSWER_MAX_BYTES = 1024 * 1024;

/** One video of a page. */
export interface SitemapVideoEntry {
  readonly title: string;
  readonly description: string;
  /** A library image: core publishes it and writes its URL. */
  readonly thumbnail: { readonly media: string };
  /** The video file on another site. */
  readonly contentUrl?: { readonly url: string };
  /** The player on another site. One of `contentUrl` and `playerUrl` is required. */
  readonly playerUrl?: { readonly url: string };
  /** Whole seconds, 1–28 800. */
  readonly durationSeconds?: number;
}

/** One page's sitemap entries. */
export interface SitemapPageEntries {
  readonly news?: { readonly title: string };
  readonly videos?: readonly SitemapVideoEntry[];
}

/** What a sitemap-entries operation returns: pages without entries are absent. */
export interface SitemapEntriesAnswer {
  readonly pages: Readonly<Record<string, SitemapPageEntries>>;
}
