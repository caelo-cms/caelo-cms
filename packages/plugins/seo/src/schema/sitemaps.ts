// SPDX-License-Identifier: MPL-2.0

/**
 * The seo plugin's news and video sitemap entries (#1761), answered at
 * core's sitemap-entries point from the same mapping as the structured
 * data. Pure.
 *
 * - News: pages of a type mapped to NewsArticle that went live first
 *   within the last {@link NEWS_WINDOW_HOURS} hours. Google reads a news
 *   sitemap's last two days only; older articles stay in `sitemap.xml`.
 * - Video: pages of a type mapped to VideoObject with a thumbnail, a
 *   description and the video's address on its host (`content_url` or
 *   `embed_url`), the duration read from the ISO 8601 `duration` role.
 *
 * Core writes the files, only for the pages `sitemap.xml` lists.
 */

import {
  SITEMAP_DESCRIPTION_MAX,
  SITEMAP_TITLE_MAX,
  type SitemapEntriesAnswer,
  type SitemapPageEntries,
  type SitemapVideoEntry,
} from "@caelo-cms/plugin-sdk";
import { type NodeContext, roleValues } from "./values.js";

/** How old a news article may be to be in the news sitemap. */
export const NEWS_WINDOW_HOURS = 48;

const DURATION_RE = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/;

/**
 * `text` within `max` UTF-16 units (the host's measure): unchanged when it
 * fits, else cut at a character boundary (never inside a surrogate pair)
 * and ended with an ellipsis. The graph keeps the full text; a sitemap's
 * title and description have a limit of their own.
 */
export function boundedText(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/** Whole seconds of a `PT…` duration, or undefined for anything else (days included). */
export function durationSeconds(iso: string): number | undefined {
  const m = DURATION_RE.exec(iso);
  if (!m || iso === "PT") return undefined;
  const s = Math.round(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0));
  return s >= 1 && s <= 28_800 ? s : undefined;
}

/**
 * The entries of every asked page of a news or video type.
 *
 * @param now the build's clock, for the news window.
 */
export function sitemapEntriesAnswer(ctx: NodeContext, now: Date): SitemapEntriesAnswer {
  const pages: Record<string, SitemapPageEntries> = {};
  for (const page of ctx.args.pages) {
    const mapping = ctx.mappings.get(page.pageType);
    if (!mapping) continue;
    if (mapping.schemaType === "NewsArticle" && page.publishedAt !== null) {
      const age = now.getTime() - Date.parse(page.publishedAt);
      if (age >= 0 && age <= NEWS_WINDOW_HOURS * 3_600_000) {
        pages[page.pageId] = { news: { title: boundedText(page.title, SITEMAP_TITLE_MAX) } };
      }
    }
    if (mapping.schemaType === "VideoObject") {
      const one = (role: string) => roleValues(ctx, page, mapping, role)[0];
      const title = one("name");
      const description = one("description");
      const thumbnail = one("thumbnail");
      const content = one("content_url");
      const player = one("embed_url");
      const duration = one("duration");
      if (
        typeof title !== "string" ||
        typeof description !== "string" ||
        typeof thumbnail !== "object" ||
        !("media" in thumbnail)
      ) {
        continue;
      }
      const video: { -readonly [K in keyof SitemapVideoEntry]: SitemapVideoEntry[K] } = {
        title: boundedText(title, SITEMAP_TITLE_MAX),
        description: boundedText(description, SITEMAP_DESCRIPTION_MAX),
        thumbnail: { media: thumbnail.media },
      };
      if (typeof content === "object" && "url" in content) video.contentUrl = { url: content.url };
      if (typeof player === "object" && "url" in player) video.playerUrl = { url: player.url };
      if (!video.contentUrl && !video.playerUrl) continue;
      const seconds = typeof duration === "string" ? durationSeconds(duration) : undefined;
      if (seconds !== undefined) video.durationSeconds = seconds;
      pages[page.pageId] = { ...pages[page.pageId], videos: [video] };
    }
  }
  return { pages };
}
