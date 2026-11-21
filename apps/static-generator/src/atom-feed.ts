// SPDX-License-Identifier: MPL-2.0

/**
 * `/feed.xml` — the site's Atom 1.0 feed (RFC 4287) of the pages changed
 * last (docs/dev/search-engine-feed.md). Each entry names a page by a
 * permanent id (`urn:uuid:<page id>`, which survives a URL change), its
 * canonical URL, when it was first published and when what it shows last
 * changed. The feed names its WebSub hub, so subscribers learn of a Publish
 * live from the hub instead of polling.
 */

import type { FeedEntry } from "./content-states.js";

/** Escape text for XML; drops the control characters XML 1.0 cannot carry. */
export function xmlText(s: string): string {
  return (
    s
      // biome-ignore lint/suspicious/noControlCharactersInRegex: these are exactly the characters XML 1.0 forbids.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  );
}

/** Render the feed. Deterministic: the same entries give the same bytes. */
export function renderAtomFeed(args: {
  /** The feed's own absolute URL: its id and its `self` link. */
  readonly feedUrl: string;
  /** The site's home page. */
  readonly siteUrl: string;
  /** The site's name: the feed's title and author. */
  readonly title: string;
  /** BCP 47 tag of the site language. */
  readonly language: string;
  readonly hubUrl: string;
  /** Newest first. */
  readonly entries: readonly FeedEntry[];
  /** The feed's `<updated>` when it has no entry (the build's publish instant). */
  readonly emptyUpdated: string;
}): string {
  const updated = args.entries[0]?.changedAt ?? args.emptyUpdated;
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${xmlText(args.language)}">`,
    `  <id>${xmlText(args.feedUrl)}</id>`,
    `  <title>${xmlText(args.title)}</title>`,
    `  <updated>${xmlText(updated)}</updated>`,
    `  <author><name>${xmlText(args.title)}</name></author>`,
    `  <link rel="self" type="application/atom+xml" href="${xmlText(args.feedUrl)}"/>`,
    `  <link rel="alternate" type="text/html" href="${xmlText(args.siteUrl)}"/>`,
    `  <link rel="hub" href="${xmlText(args.hubUrl)}"/>`,
  ];
  for (const e of args.entries) {
    lines.push(
      "  <entry>",
      `    <id>urn:uuid:${xmlText(e.pageId)}</id>`,
      `    <title>${xmlText(e.title)}</title>`,
      `    <link rel="alternate" type="text/html" href="${xmlText(e.url)}"/>`,
      `    <published>${xmlText(e.publishedAt)}</published>`,
      `    <updated>${xmlText(e.changedAt)}</updated>`,
      ...(e.summary.trim().length > 0
        ? [`    <summary>${xmlText(e.summary.trim())}</summary>`]
        : []),
      "  </entry>",
    );
  }
  lines.push("</feed>", "");
  return lines.join("\n");
}
