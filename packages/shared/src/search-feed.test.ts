// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  indexNowKeyFile,
  isPublicSiteHost,
  pageChangeSchema,
  siteFeedLink,
  siteFeedTitle,
  siteFeedUrl,
} from "./search-feed.js";

describe("the site's feed", () => {
  it("lives at /feed.xml and is titled with the host", () => {
    expect(siteFeedUrl("https://www.example.com/")).toBe("https://www.example.com/feed.xml");
    expect(siteFeedTitle("https://www.example.com")).toBe("www.example.com");
    expect(siteFeedLink(true, "https://example.com")).toEqual({
      url: "https://example.com/feed.xml",
      title: "example.com",
    });
    expect(siteFeedLink(false, "https://example.com")).toBeNull();
  });

  it("serves the IndexNow key at the root", () => {
    expect(indexNowKeyFile("abcdef12")).toBe("abcdef12.txt");
  });
});

describe("isPublicSiteHost", () => {
  it("accepts public names", () => {
    expect(isPublicSiteHost("www.example.org")).toBe(true);
    expect(isPublicSiteHost("caelo-cms.com")).toBe(true);
  });

  it("refuses names and addresses search engines cannot reach", () => {
    for (const host of [
      "localhost",
      "admin.localhost",
      "intranet",
      "site.local",
      "api.internal",
      "foo.test",
      "example",
      "printer.home.arpa",
      "127.0.0.1",
      "[::1]",
      "",
    ]) {
      expect(isPublicSiteHost(host)).toBe(false);
    }
  });
});

describe("pageChangeSchema", () => {
  const change = {
    pageId: "11111111-1111-4111-8111-111111111111",
    kind: "changed",
    url: "https://example.com/a/",
    fingerprint: "a".repeat(64),
    pluginFingerprint: null,
    title: "A",
    summary: "",
    prevUrl: "https://example.com/a/",
    changedAt: "2026-11-20T12:00:00.000Z",
  };

  it("accepts a change and a removal", () => {
    expect(pageChangeSchema.safeParse(change).success).toBe(true);
    expect(
      pageChangeSchema.safeParse({
        ...change,
        kind: "removed",
        url: null,
        fingerprint: null,
        title: null,
        summary: null,
      }).success,
    ).toBe(true);
  });

  it("refuses a plugin fingerprint on a removed page", () => {
    expect(
      pageChangeSchema.safeParse({
        ...change,
        kind: "removed",
        url: null,
        fingerprint: null,
        title: null,
        summary: null,
        pluginFingerprint: "b".repeat(64),
      }).success,
    ).toBe(false);
  });

  it("refuses a live page without a title or a removed one with one", () => {
    expect(pageChangeSchema.safeParse({ ...change, title: null }).success).toBe(false);
    expect(
      pageChangeSchema.safeParse({
        ...change,
        kind: "removed",
        url: null,
        fingerprint: null,
        summary: null,
      }).success,
    ).toBe(false);
  });

  it("refuses a removal with a URL and a live page without one", () => {
    expect(pageChangeSchema.safeParse({ ...change, kind: "removed" }).success).toBe(false);
    expect(pageChangeSchema.safeParse({ ...change, url: null, fingerprint: null }).success).toBe(
      false,
    );
    expect(pageChangeSchema.safeParse({ ...change, fingerprint: null }).success).toBe(false);
  });
});
