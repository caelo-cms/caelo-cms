// SPDX-License-Identifier: MPL-2.0

/** issue #425 — pure scope logic: URL normalisation, segment-aware
 *  path-prefix matching, hreflang locale matching + alternate picking. */

import { describe, expect, it } from "bun:test";
import {
  hreflangMatchesLocale,
  isPathInScope,
  normalizeCrawlUrl,
  pickLocaleAlternate,
} from "./crawl-scope.js";

describe("normalizeCrawlUrl (#425)", () => {
  it("drops the hash and collapses trailing slashes", () => {
    expect(normalizeCrawlUrl("https://site.example/a/#top")).toBe("https://site.example/a");
    expect(normalizeCrawlUrl("https://site.example/a//")).toBe("https://site.example/a");
    expect(normalizeCrawlUrl("https://site.example/")).toBe("https://site.example/");
  });

  it("preserves the query string — an explicit ?page=2 is a distinct page", () => {
    expect(normalizeCrawlUrl("https://site.example/list/?page=2")).toBe(
      "https://site.example/list?page=2",
    );
  });
});

describe("isPathInScope (#425)", () => {
  it("matches the prefix itself and everything under it", () => {
    expect(isPathInScope("/de", "/de/")).toBe(true);
    expect(isPathInScope("/de/", "/de")).toBe(true);
    expect(isPathInScope("/de/blog/post", "/de/")).toBe(true);
  });

  it("is segment-aware — no blind string-prefix match (R8 discipline)", () => {
    expect(isPathInScope("/design", "/de")).toBe(false);
    expect(isPathInScope("/development/x", "/de/")).toBe(false);
  });

  it('"/" scopes everything', () => {
    expect(isPathInScope("/anything/at/all", "/")).toBe(true);
    expect(isPathInScope("/", "/")).toBe(true);
  });

  it("rejects paths outside the prefix", () => {
    expect(isPathInScope("/en/about", "/de/")).toBe(false);
    expect(isPathInScope("/", "/de/")).toBe(false);
  });
});

describe("hreflangMatchesLocale (#425)", () => {
  it("matches exact codes case-insensitively", () => {
    expect(hreflangMatchesLocale("DE", "de")).toBe(true);
    expect(hreflangMatchesLocale("de", "DE")).toBe(true);
  });

  it("a bare scope locale accepts regional variants", () => {
    expect(hreflangMatchesLocale("de-AT", "de")).toBe(true);
    expect(hreflangMatchesLocale("pt-BR", "pt")).toBe(true);
  });

  it("a regional scope locale requires the exact code", () => {
    expect(hreflangMatchesLocale("pt", "pt-br")).toBe(false);
    expect(hreflangMatchesLocale("pt-PT", "pt-br")).toBe(false);
  });

  it("never matches x-default or unrelated codes sharing letters", () => {
    expect(hreflangMatchesLocale("x-default", "de")).toBe(false);
    expect(hreflangMatchesLocale("den", "de")).toBe(false);
  });
});

describe("pickLocaleAlternate (#425)", () => {
  const alts = [
    { hreflang: "x-default", href: "https://site.example/" },
    { hreflang: "de-AT", href: "https://site.example/at" },
    { hreflang: "de", href: "https://site.example/de-page" },
    { hreflang: "en", href: "https://site.example/en-page" },
  ];

  it("prefers the exact language code over a regional variant", () => {
    expect(pickLocaleAlternate(alts, "de")).toBe("https://site.example/de-page");
  });

  it("falls back to a regional variant when no exact code exists", () => {
    const regionalOnly = alts.filter((a) => a.hreflang !== "de");
    expect(pickLocaleAlternate(regionalOnly, "de")).toBe("https://site.example/at");
  });

  it("returns null when the set has nothing for the locale (no signal)", () => {
    expect(pickLocaleAlternate(alts, "fr")).toBeNull();
    expect(pickLocaleAlternate([], "de")).toBeNull();
  });
});
