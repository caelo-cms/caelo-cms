// SPDX-License-Identifier: MPL-2.0

/**
 * Tag embedding (#456 review): the runtime is inlined into every page
 * as one <script>, so tag data must never be able to end that element,
 * and a vendor's HTML snippet must be rejected rather than stored as
 * JavaScript that throws on every page view.
 */

import { describe, expect, it } from "bun:test";
import {
  assertInlineSnippetIsJs,
  buildTagInjector,
  declarationGaps,
  fieldsOfRow,
  jsonForInlineScript,
  resolveTagColumns,
  type TagRow,
} from "./tags.js";
import { VENDOR_TEMPLATES } from "./vendors.js";

const META_EVENTS_MANAGER =
  "<script>!function(f,b,e,v){/* fbq bootstrap */}(window,document,'script');fbq('init','123');</script>" +
  '<noscript><img height="1" width="1" src="https://www.facebook.com/tr?id=123&ev=PageView"/></noscript>';

describe("jsonForInlineScript", () => {
  it("cannot close the surrounding <script>", () => {
    const out = jsonForInlineScript({ inline: "a</script><img src=x onerror=alert(1)>" });
    expect(out).not.toContain("</");
    expect(JSON.parse(out)).toEqual({ inline: "a</script><img src=x onerror=alert(1)>" });
  });

  it("escapes the JS line separators", () => {
    expect(jsonForInlineScript("a b c")).toBe('"a\\u2028b\\u2029c"');
  });
});

describe("buildTagInjector", () => {
  it("keeps tag data from terminating the inline runtime", () => {
    const js = buildTagInjector([
      {
        name: "t",
        category: "marketing",
        position: "body_end",
        src: "",
        inline: "x='</script>';",
        cookies: [{ name: "</script>", prefix: false }],
        scope: { include: ["/</script>"], exclude: [], locales: null },
      },
    ]);
    expect(js).not.toContain("</script>");
  });
});

describe("assertInlineSnippetIsJs", () => {
  it("rejects the snippet exactly as Meta's Events Manager hands it out", () => {
    expect(() => assertInlineSnippetIsJs("add_tag", META_EVENTS_MANAGER)).toThrow(
      /INSIDE the vendor's <script>/,
    );
  });

  it("accepts the JavaScript between the tags", () => {
    expect(() =>
      assertInlineSnippetIsJs("add_tag", "fbq('init','123');fbq('track','PageView');"),
    ).not.toThrow();
  });
});

const CATEGORIES = new Set(["necessary", "functional", "analytics", "marketing"]);

describe("vendor templates (#1135)", () => {
  it("builds Google Analytics from the measurement id, as Google's snippet", () => {
    const t = resolveTagColumns(
      "add_tag",
      { vendor: "google-analytics", config: { measurementId: "G-ABC123XYZ9" } },
      CATEGORIES,
    );
    // The loader needs the id in its URL; without it gtag.js loads nothing.
    expect(t.script_src).toBe("https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ9");
    expect(t.inline_snippet).toContain("gtag('config', \"G-ABC123XYZ9\");");
    expect(t.category_key).toBe("analytics");
    expect(t.config).toEqual({ measurementId: "G-ABC123XYZ9" });
    expect(t.cookies.map((c) => c.name)).toEqual(["_ga", "_ga_"]);
    expect(t.vendor_info.name).toBe("Google Ireland Limited");
    expect(t.vendor_info.legalBasis).toContain("Consent");
  });

  it("names the expected format when an id is missing or malformed", () => {
    expect(() => resolveTagColumns("add_tag", { vendor: "google-analytics" }, CATEGORIES)).toThrow(
      /config\.measurementId as G- followed by/,
    );
    expect(() =>
      resolveTagColumns(
        "add_tag",
        { vendor: "leadinfo", config: { accountId: "12345" } },
        CATEGORIES,
      ),
    ).toThrow(/LI- followed by digits.*got "12345"/);
    expect(() =>
      resolveTagColumns(
        "add_tag",
        { vendor: "matomo", config: { trackerUrl: "http://m.example.com/", siteId: "1" } },
        CATEGORIES,
      ),
    ).toThrow(/https URL/);
  });

  it("refuses a hand-written snippet for a known vendor and config for an unknown one", () => {
    expect(() =>
      resolveTagColumns(
        "add_tag",
        { vendor: "meta-pixel", config: { pixelId: "123456789" }, inlineSnippet: "fbq()" },
        CATEGORIES,
      ),
    ).toThrow(/built from `config`/);
    expect(() =>
      resolveTagColumns(
        "add_tag",
        {
          vendor: "acme",
          category: "analytics",
          config: { id: "1" },
          scriptSrc: "https://a.example/x.js",
        },
        CATEGORIES,
      ),
    ).toThrow(/only for the known vendors/);
  });

  it("builds every template into code that parses and spells no closing script tag", () => {
    const configs: Record<string, Record<string, string>> = {
      "google-analytics": { measurementId: "G-ABC123" },
      "google-tag-manager": { containerId: "GTM-ABC1234" },
      "meta-pixel": { pixelId: "123456789012345" },
      matomo: { trackerUrl: "https://analytics.example.com", siteId: "3" },
      hotjar: { siteId: "1234567" },
      leadinfo: { accountId: "LI-1234567890" },
    };
    expect(Object.keys(configs).sort()).toEqual(Object.keys(VENDOR_TEMPLATES).sort());
    for (const [vendor, config] of Object.entries(configs)) {
      const t = resolveTagColumns("add_tag", { vendor, config }, CATEGORIES);
      expect(() => new Function(t.inline_snippet)).not.toThrow();
      expect(/<\/script|<!--/i.test(t.inline_snippet)).toBe(false);
      for (const value of Object.values(config)) {
        expect(`${t.script_src}${t.inline_snippet}`).toContain(value.replace(/\/$/, ""));
      }
    }
  });

  it("lets the operator override cookies and fill vendor data", () => {
    const t = resolveTagColumns(
      "add_tag",
      {
        vendor: "matomo",
        config: { trackerUrl: "https://analytics.example.com/", siteId: "1" },
        cookies: [{ name: "_pk_id", pattern: true, lifetime: "6 months", purpose: "Visitor id." }],
        vendorInfo: { name: "Example GmbH", seat: "Berlin" },
      },
      CATEGORIES,
    );
    expect(t.cookies).toHaveLength(1);
    expect(t.vendor_info.name).toBe("Example GmbH");
    expect(t.vendor_info.purpose).toContain("Measures");
    expect(declarationGaps(t)).toEqual([
      "vendorInfo.privacyPolicyUrl: the vendor's privacy policy",
    ]);
  });

  it("re-derives a templated tag from its config on update, not from the stored code", () => {
    const stored = resolveTagColumns(
      "add_tag",
      { vendor: "google-analytics", config: { measurementId: "G-OLD111" } },
      CATEGORIES,
    );
    const row: TagRow = { id: "t1", name: "GA4", enabled: true, ...stored };
    const next = resolveTagColumns(
      "update_tags_many",
      { ...fieldsOfRow(row), config: { measurementId: "G-NEW222" } },
      CATEGORIES,
    );
    expect(next.script_src).toContain("G-NEW222");
    expect(next.inline_snippet).not.toContain("G-OLD111");
  });
});
