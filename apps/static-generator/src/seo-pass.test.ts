// SPDX-License-Identifier: MPL-2.0
/**
 * Migration 0232: a new build needs a configured site language; nothing
 * substitutes `en`. Promote/rollback read the stored settings without this
 * narrowing, so it lives in its own function.
 */
import { describe, expect, it } from "bun:test";
import { requireSiteLanguage, type StoredSeoSettings } from "./seo-pass.js";

const STORED: StoredSeoSettings = {
  siteBaseUrl: "https://example.com",
  sitemapEnabled: true,
  siteLanguage: null,
  organization: {},
};

describe("requireSiteLanguage", () => {
  it("refuses an unset language with the next step, never a substitute", () => {
    expect(() => requireSiteLanguage(STORED)).toThrow("Site language is not configured");
    expect(() => requireSiteLanguage(STORED)).toThrow("set_site_identity");
  });

  it("passes a configured language through unchanged", () => {
    expect(requireSiteLanguage({ ...STORED, siteLanguage: "de-AT" })).toEqual({
      ...STORED,
      siteLanguage: "de-AT",
    });
  });
});
