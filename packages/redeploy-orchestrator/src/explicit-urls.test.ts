// SPDX-License-Identifier: MPL-2.0

/**
 * issue #229 — LIST mode's "exact URL set" contract at the decode
 * boundary: absent = depth mode, present-but-malformed = loud failure,
 * NEVER a silent fallback to BFS (CLAUDE.md §2 no-fallbacks).
 */

import { describe, expect, it } from "bun:test";
import { ExplicitUrlsMalformedError, parseExplicitUrls } from "./explicit-urls.js";

describe("parseExplicitUrls (#229)", () => {
  it("returns null ONLY for absent values (SQL NULL / undefined / jsonb null)", () => {
    expect(parseExplicitUrls(null)).toBeNull();
    expect(parseExplicitUrls(undefined)).toBeNull();
    // jsonb null serialised to a JSON string by the client.
    expect(parseExplicitUrls("null")).toBeNull();
  });

  it("decodes an already-parsed jsonb array", () => {
    expect(parseExplicitUrls(["https://a.example/", "https://a.example/b"])).toEqual([
      "https://a.example/",
      "https://a.example/b",
    ]);
  });

  it("decodes a JSON-string-encoded array", () => {
    expect(parseExplicitUrls('["https://a.example/x"]')).toEqual(["https://a.example/x"]);
  });

  it("throws on an unparseable JSON string, naming the bad value", () => {
    expect(() => parseExplicitUrls("{not json")).toThrow(ExplicitUrlsMalformedError);
    expect(() => parseExplicitUrls("{not json")).toThrow(/\{not json/);
    expect(() => parseExplicitUrls("{not json")).toThrow(/refusing to fall back/);
  });

  it("throws on non-array shapes instead of falling back to depth mode", () => {
    expect(() => parseExplicitUrls({ urls: ["https://a.example/"] })).toThrow(
      ExplicitUrlsMalformedError,
    );
    expect(() => parseExplicitUrls(42)).toThrow(ExplicitUrlsMalformedError);
    expect(() => parseExplicitUrls('"https://a.example/"')).toThrow(ExplicitUrlsMalformedError);
  });

  it("throws on an empty array — an approved LIST run with zero URLs is a bug", () => {
    expect(() => parseExplicitUrls([])).toThrow(ExplicitUrlsMalformedError);
    expect(() => parseExplicitUrls("[]")).toThrow(/array is empty/);
  });

  it("throws on non-string entries rather than silently dropping them", () => {
    expect(() => parseExplicitUrls(["https://a.example/", 7])).toThrow(
      /entry at index 1 is not a string/,
    );
    expect(() => parseExplicitUrls([null])).toThrow(ExplicitUrlsMalformedError);
    expect(() => parseExplicitUrls([undefined])).toThrow(ExplicitUrlsMalformedError);
  });
});
