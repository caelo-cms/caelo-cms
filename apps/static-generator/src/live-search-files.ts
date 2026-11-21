// SPDX-License-Identifier: MPL-2.0

/**
 * The two files of a live build that speak for the live record
 * (docs/dev/search-engine-feed.md): `/feed.xml` and the sitemap's
 * `<lastmod>`. A full build writes them; a plugin-data build (#1155), which
 * changes what plugins baked into some pages and nothing else, brings only
 * those pages' entries up to date in the live copies, so the dates search
 * engines read match the record. Everything else in them stays as published.
 *
 * Both files are this generator's own output (atom-feed.ts, seo-pass.ts),
 * so they are read back in that exact shape and refused otherwise.
 */

import { FEED_ENTRY_LIMIT } from "@caelo-cms/shared";
import { Parser } from "htmlparser2";
import { renderAtomFeed } from "./atom-feed.js";
import type { FeedEntry } from "./content-states.js";

/** A feed as {@link renderAtomFeed} wrote it. */
export interface ParsedAtomFeed {
  readonly feedUrl: string;
  readonly siteUrl: string;
  readonly title: string;
  readonly language: string;
  readonly hubUrl: string;
  readonly updated: string;
  readonly entries: FeedEntry[];
}

const PAGE_ID_PREFIX = "urn:uuid:";

/** Read a feed this generator wrote. Throws when it is not one. */
export function parseAtomFeed(xml: string): ParsedAtomFeed {
  const feed: Record<string, string> = {};
  const entries: FeedEntry[] = [];
  let entry: Record<string, string> | null = null;
  let field: string | null = null;
  let text = "";
  let inAuthor = false;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "feed") feed.language = attrs["xml:lang"] ?? "";
        else if (name === "entry") entry = {};
        else if (name === "author") inAuthor = true;
        else if (name === "link") {
          const target = entry ?? feed;
          const rel = attrs.rel ?? "alternate";
          if (attrs.href !== undefined) target[`link:${rel}`] = attrs.href;
        } else if (!inAuthor) {
          field = name;
          text = "";
        }
      },
      ontext(t) {
        if (field !== null) text += t;
      },
      onclosetag(name) {
        if (name === "author") inAuthor = false;
        else if (name === "entry" && entry !== null) {
          const e: Record<string, string> = entry;
          const id = e.id ?? "";
          if (!id.startsWith(PAGE_ID_PREFIX))
            throw new Error(`feed entry id "${id}" names no page`);
          entries.push({
            pageId: id.slice(PAGE_ID_PREFIX.length),
            url: e["link:alternate"] ?? "",
            title: e.title ?? "",
            summary: e.summary ?? "",
            changedAt: e.updated ?? "",
            publishedAt: e.published ?? "",
          });
          entry = null;
        } else if (field === name) {
          (entry ?? feed)[name] = text;
          field = null;
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(xml);
  parser.end();
  const required = ["id", "title", "updated", "link:alternate", "link:hub"] as const;
  for (const k of required) {
    if (feed[k] === undefined)
      throw new Error(`the live feed has no ${k}; Publish live rebuilds it`);
  }
  return {
    feedUrl: feed.id ?? "",
    siteUrl: feed["link:alternate"] ?? "",
    title: feed.title ?? "",
    language: feed.language ?? "",
    hubUrl: feed["link:hub"] ?? "",
    updated: feed.updated ?? "",
    entries,
  };
}

/**
 * The live feed with `changed` pages brought up to date: their entries carry
 * the new date (an entry is added when the page was not among the newest),
 * the newest {@link FEED_ENTRY_LIMIT} stay, newest first, as a full build
 * orders them.
 */
export function updateAtomFeed(xml: string, changed: readonly FeedEntry[]): string {
  const feed = parseAtomFeed(xml);
  const byId = new Map(feed.entries.map((e) => [e.pageId, e]));
  for (const c of changed) byId.set(c.pageId, c);
  const entries = [...byId.values()]
    .sort((a, b) =>
      a.changedAt !== b.changedAt
        ? a.changedAt < b.changedAt
          ? 1
          : -1
        : a.url < b.url
          ? -1
          : a.url > b.url
            ? 1
            : 0,
    )
    .slice(0, FEED_ENTRY_LIMIT);
  return renderAtomFeed({
    feedUrl: feed.feedUrl,
    siteUrl: feed.siteUrl,
    title: feed.title,
    language: feed.language,
    hubUrl: feed.hubUrl,
    entries,
    emptyUpdated: feed.updated,
  });
}

/** XML-escape a URL the way seo-pass.ts writes `<loc>`. */
function locText(url: string): string {
  return url
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The live sitemap with the `<lastmod>` of these URLs replaced; every other
 * byte stays. A URL the sitemap does not list is left out (the page is not
 * in it: noindex, or the sitemap is off).
 */
export function patchSitemapLastmod(
  xml: string,
  lastmodByUrl: ReadonlyMap<string, string>,
): string {
  const byLoc = new Map([...lastmodByUrl].map(([url, at]) => [`<loc>${locText(url)}</loc>`, at]));
  let out = "";
  let at = 0;
  for (;;) {
    const open = xml.indexOf("<url>", at);
    if (open === -1) break;
    const close = xml.indexOf("</url>", open);
    if (close === -1) break;
    const block = xml.slice(open, close);
    let next = block;
    const locStart = block.indexOf("<loc>");
    const locEnd = block.indexOf("</loc>", locStart);
    const lastmod =
      locStart === -1 || locEnd === -1 ? undefined : byLoc.get(block.slice(locStart, locEnd + 6));
    if (lastmod !== undefined) {
      const s = block.indexOf("<lastmod>");
      const e = block.indexOf("</lastmod>", s);
      if (s !== -1 && e !== -1) next = `${block.slice(0, s + 9)}${lastmod}${block.slice(e)}`;
    }
    out += xml.slice(at, open) + next;
    at = close;
  }
  return out + xml.slice(at);
}

/**
 * The `<title>` and meta description a live page shipped with: what a feed
 * entry shows for a page that joins the feed through a plugin-data build,
 * taken from the published file and never from the stored page row, which
 * may hold what nobody published.
 */
export function publishedTitleAndSummary(pageHtml: string): { title: string; summary: string } {
  let title = "";
  let summary = "";
  let inTitle = false;
  let seenTitle = false;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "title" && !seenTitle) inTitle = true;
        if (name === "meta" && attrs.name === "description" && summary === "") {
          summary = attrs.content ?? "";
        }
      },
      ontext(t) {
        if (inTitle) title += t;
      },
      onclosetag(name) {
        if (name === "title" && inTitle) {
          inTitle = false;
          seenTitle = true;
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(pageHtml);
  parser.end();
  return { title: title.trim(), summary: summary.trim() };
}
