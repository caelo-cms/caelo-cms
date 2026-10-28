// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { livePageAvailability, type MainPage, settleLiveUrl } from "./live-links.js";

const page: MainPage = { id: "p1", slug: "preise", status: "published", currentPath: "/preise" };

describe("livePageAvailability", () => {
  it("links a published page while production serves the latest staging", () => {
    expect(livePageAvailability(page, true)).toEqual({ live: true });
  });

  it("does not link a page main does not have or has as a draft", () => {
    expect(livePageAvailability(null, true).live).toBe(false);
    expect(livePageAvailability({ ...page, status: "draft" }, true).live).toBe(false);
  });

  it("does not link while a newer Stage waits for Publish live", () => {
    const r = livePageAvailability(page, false);
    expect(r).toEqual({
      live: false,
      note: "A newer staged build is not live yet, so this page's live address may differ until Publish live.",
    });
  });

  it("does not link before anything of the current staging went live", () => {
    expect(livePageAvailability(page, null).live).toBe(false);
  });
});

describe("settleLiveUrl", () => {
  it("returns the built page URL", async () => {
    expect(
      await settleLiveUrl("https://example.com", async () => "https://de.example.com/preise/"),
    ).toEqual({
      error: null,
      siteUrl: "https://example.com",
      pageUrl: "https://de.example.com/preise/",
      pageNote: null,
    });
  });

  it("turns a failing host contribution into the menu's error instead of throwing", async () => {
    const links = await settleLiveUrl("https://example.com", async () => {
      throw new Error("international-site url_annotations failed");
    });
    expect(links).toEqual({
      error:
        "The page's live address could not be built: international-site url_annotations failed",
      siteUrl: "https://example.com",
      pageUrl: null,
      pageNote: null,
    });
  });
});
