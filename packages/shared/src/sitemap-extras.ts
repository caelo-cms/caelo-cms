// SPDX-License-Identifier: MPL-2.0

/**
 * #1761 — the news and video sitemaps core writes next to `sitemap.xml`
 * from the entries plugins contribute (plugin SDK `sitemap-entries.ts`).
 * Pure serializers: the static generator decides which pages are in them
 * (only the pages `sitemap.xml` lists) and writes the files; robots.txt
 * names every sitemap the build wrote.
 */

/** One article of the news sitemap. */
export interface NewsSitemapEntry {
  /** The page's public URL (its canonical). */
  readonly loc: string;
  readonly title: string;
  /** The publication's name: the site's name. */
  readonly publicationName: string;
  /** The page's document language (BCP 47). */
  readonly language: string;
  /** When the page went live first (ISO 8601). */
  readonly publicationDate: string;
}

/** One video of a page in the video sitemap. */
export interface VideoSitemapVideo {
  readonly thumbnailLoc: string;
  readonly title: string;
  readonly description: string;
  readonly contentLoc?: string;
  readonly playerLoc?: string;
  readonly durationSeconds?: number;
  /** When the page went live first (ISO 8601), when known. */
  readonly publicationDate?: string;
}

/** One page of the video sitemap with its videos. */
export interface VideoSitemapEntry {
  readonly loc: string;
  readonly videos: readonly VideoSitemapVideo[];
}

function xml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The news sitemap's language code: ISO 639 (`de`, `en`), except Chinese,
 * which Google reads as `zh-cn` / `zh-tw`.
 */
export function newsLanguage(lang: string): string {
  const lower = lang.toLowerCase();
  if (lower === "zh-cn" || lower === "zh-hans" || lower === "zh-hans-cn") return "zh-cn";
  if (lower === "zh-tw" || lower === "zh-hant" || lower === "zh-hant-tw") return "zh-tw";
  return lower.split("-")[0] ?? lower;
}

/** `sitemap-news.xml`. */
export function renderNewsSitemap(entries: readonly NewsSitemapEntry[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">',
    ...entries.map((e) =>
      [
        "  <url>",
        `    <loc>${xml(e.loc)}</loc>`,
        "    <news:news>",
        "      <news:publication>",
        `        <news:name>${xml(e.publicationName)}</news:name>`,
        `        <news:language>${xml(newsLanguage(e.language))}</news:language>`,
        "      </news:publication>",
        `      <news:publication_date>${xml(e.publicationDate)}</news:publication_date>`,
        `      <news:title>${xml(e.title)}</news:title>`,
        "    </news:news>",
        "  </url>",
      ].join("\n"),
    ),
    "</urlset>",
    "",
  ].join("\n");
}

/** `sitemap-video.xml`. */
export function renderVideoSitemap(entries: readonly VideoSitemapEntry[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">',
    ...entries.map((e) =>
      [
        "  <url>",
        `    <loc>${xml(e.loc)}</loc>`,
        ...e.videos.map((v) =>
          [
            "    <video:video>",
            `      <video:thumbnail_loc>${xml(v.thumbnailLoc)}</video:thumbnail_loc>`,
            `      <video:title>${xml(v.title)}</video:title>`,
            `      <video:description>${xml(v.description)}</video:description>`,
            ...(v.contentLoc
              ? [`      <video:content_loc>${xml(v.contentLoc)}</video:content_loc>`]
              : []),
            ...(v.playerLoc
              ? [`      <video:player_loc>${xml(v.playerLoc)}</video:player_loc>`]
              : []),
            ...(v.durationSeconds !== undefined
              ? [`      <video:duration>${v.durationSeconds}</video:duration>`]
              : []),
            ...(v.publicationDate
              ? [`      <video:publication_date>${xml(v.publicationDate)}</video:publication_date>`]
              : []),
            "    </video:video>",
          ].join("\n"),
        ),
        "  </url>",
      ].join("\n"),
    ),
    "</urlset>",
    "",
  ].join("\n");
}
