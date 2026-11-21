// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { renderAtomFeed, xmlText } from "./atom-feed.js";

const ENTRY = {
  pageId: "11111111-1111-4111-8111-111111111111",
  url: "https://example.com/news/launch/",
  title: "Launch <beta> & more",
  summary: "What is new",
  changedAt: "2026-11-20T10:00:00.000Z",
  publishedAt: "2026-11-01T08:00:00.000Z",
};

function feed(entries: (typeof ENTRY)[]) {
  return renderAtomFeed({
    feedUrl: "https://example.com/feed.xml",
    siteUrl: "https://example.com/",
    title: "example.com",
    language: "de",
    hubUrl: "https://pubsubhubbub.appspot.com/",
    entries,
    emptyUpdated: "2026-11-21T00:00:00.000Z",
  });
}

describe("renderAtomFeed", () => {
  it("names itself, the site and its WebSub hub", () => {
    const xml = feed([ENTRY]);
    expect(xml).toStartWith('<?xml version="1.0" encoding="utf-8"?>\n');
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="de">');
    expect(xml).toContain("<id>https://example.com/feed.xml</id>");
    expect(xml).toContain(
      '<link rel="self" type="application/atom+xml" href="https://example.com/feed.xml"/>',
    );
    expect(xml).toContain('<link rel="alternate" type="text/html" href="https://example.com/"/>');
    expect(xml).toContain('<link rel="hub" href="https://pubsubhubbub.appspot.com/"/>');
    expect(xml).toContain("<author><name>example.com</name></author>");
  });

  it("carries each page's permanent id, URL, dates and summary, escaped", () => {
    const xml = feed([ENTRY]);
    expect(xml).toContain(`<id>urn:uuid:${ENTRY.pageId}</id>`);
    expect(xml).toContain("<title>Launch &lt;beta&gt; &amp; more</title>");
    expect(xml).toContain(
      '<link rel="alternate" type="text/html" href="https://example.com/news/launch/"/>',
    );
    expect(xml).toContain("<published>2026-11-01T08:00:00.000Z</published>");
    expect(xml).toContain("<updated>2026-11-20T10:00:00.000Z</updated>");
    expect(xml).toContain("<summary>What is new</summary>");
  });

  it("dates the feed by its newest entry, or the build when it has none", () => {
    expect(feed([ENTRY])).toContain("  <updated>2026-11-20T10:00:00.000Z</updated>\n  <author>");
    expect(feed([])).toContain("  <updated>2026-11-21T00:00:00.000Z</updated>");
    expect(feed([])).not.toContain("<entry>");
  });

  it("leaves out an empty summary", () => {
    expect(feed([{ ...ENTRY, summary: "  " }])).not.toContain("<summary>");
  });
});

describe("xmlText", () => {
  it("drops the control characters XML 1.0 cannot carry", () => {
    expect(xmlText("a\u0000b\u0008c\td\ne")).toBe("abc\td\ne");
  });
});
