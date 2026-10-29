// SPDX-License-Identifier: MPL-2.0

/** issue #425 — the crawl_scope jsonb decode contract: NULL means
 *  unscoped; anything present-but-malformed fails LOUDLY (a scoped
 *  crawl must never silently degrade to an unscoped one). */

import { describe, expect, it } from "bun:test";
import { CrawlScopeMalformedError, parseCrawlScope } from "./crawl-scope.js";

describe("parseCrawlScope (#425)", () => {
  it("returns null only for SQL NULL / undefined", () => {
    expect(parseCrawlScope(null)).toBeNull();
    expect(parseCrawlScope(undefined)).toBeNull();
  });

  it("decodes the parsed jsonb object", () => {
    expect(parseCrawlScope({ pathPrefix: "/de/" })).toEqual({ pathPrefix: "/de/" });
    expect(parseCrawlScope({ pathPrefix: "/de/", locale: "de" })).toEqual({
      pathPrefix: "/de/",
      locale: "de",
    });
  });

  it("throws loudly on any present-but-malformed value", () => {
    // A double-encoded jsonb string scalar (#68) is malformed, not decoded.
    expect(() => parseCrawlScope('{"locale":"de"}')).toThrow(CrawlScopeMalformedError);
    expect(() => parseCrawlScope("not json")).toThrow(CrawlScopeMalformedError);
    expect(() => parseCrawlScope([])).toThrow(CrawlScopeMalformedError);
    expect(() => parseCrawlScope({})).toThrow(CrawlScopeMalformedError);
    expect(() => parseCrawlScope({ pathPrefix: 5 })).toThrow(CrawlScopeMalformedError);
    expect(() => parseCrawlScope({ locale: ["de"] })).toThrow(CrawlScopeMalformedError);
  });

  it("names the failure and the fix in the error message", () => {
    try {
      parseCrawlScope({});
      throw new Error("unreachable");
    } catch (e) {
      expect((e as Error).message).toContain("crawl_scope is malformed");
      expect((e as Error).message).toContain("re-approve");
    }
  });
});
