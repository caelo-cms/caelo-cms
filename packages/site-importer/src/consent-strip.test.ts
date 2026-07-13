// SPDX-License-Identifier: MPL-2.0

/**
 * Regression (2026-07-12): the source site's Complianz "Manage
 * Consent" modal was crawled as page content and rendered mid-page in
 * every composed draft. Consent chrome must be stripped at
 * extraction; body text ABOUT cookies stays.
 */

import { describe, expect, it } from "bun:test";
import { extractModulesFromHtml, stripConsentNoise } from "./extractor.js";

const CONSENT_DIV =
  '<div id="cmplz-cookiebanner-container"><div class="cmplz-cookiebanner"><h2>Manage Consent</h2><button>Accept</button><button>Deny</button></div></div>';

describe("stripConsentNoise", () => {
  it("drops Complianz banner subtrees", () => {
    const html = `<main><p>Hello</p>${CONSENT_DIV}<p>World</p></main>`;
    const out = stripConsentNoise(html);
    expect(out).not.toContain("Manage Consent");
    expect(out).toContain("Hello");
    expect(out).toContain("World");
  });

  it("drops OneTrust / Cookiebot / generic banner fingerprints", () => {
    for (const cls of [
      "onetrust-banner-sdk",
      "CookiebotWidget",
      "cookie-notice",
      "consent-modal",
    ]) {
      const out = stripConsentNoise(`<p>keep</p><div class="${cls}">noise</div>`);
      expect(out).not.toContain("noise");
      expect(out).toContain("keep");
    }
  });

  it("keeps body text that merely talks about cookies", () => {
    const html =
      "<article><h1>Our cookie recipe</h1><p>Best cookies in town, with consent of grandma.</p></article>";
    expect(stripConsentNoise(html)).toBe(html);
  });

  it("is applied by extractModulesFromHtml", () => {
    const html = `<html><body><header>H</header><main><p>Content</p></main>${CONSENT_DIV}<footer>F</footer></body></html>`;
    const { modules } = extractModulesFromHtml(html);
    const all = modules.map((m) => m.html).join("");
    expect(all).not.toContain("Manage Consent");
    expect(all).toContain("Content");
  });
});
