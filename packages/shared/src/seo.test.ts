// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  injectSeoIntoHead,
  renderSeoHead,
  resolveCanonicalUrl,
  seoAutofillInputSchema,
  seoOptimizeInputSchema,
  seoSetInputSchema,
  siteDefaultsSetSeoInputSchema,
} from "./seo.js";

describe("resolveCanonicalUrl", () => {
  it("uses the explicit override when provided", () => {
    expect(
      resolveCanonicalUrl({
        siteBaseUrl: "https://example.com",
        pageSlug: "anything",
        pageLocale: "en",
        override: "https://canonical.example.com/x",
      }),
    ).toBe("https://canonical.example.com/x");
  });

  it("renders home as the root path", () => {
    expect(
      resolveCanonicalUrl({
        siteBaseUrl: "https://example.com",
        pageSlug: "home",
        pageLocale: "en",
        override: null,
      }),
    ).toBe("https://example.com/");
  });

  it("trims trailing slash on the base URL", () => {
    expect(
      resolveCanonicalUrl({
        siteBaseUrl: "https://example.com/",
        pageSlug: "about",
        pageLocale: "en",
        override: null,
      }),
    ).toBe("https://example.com/about/");
  });

  describe("v0.2.85 — pageUrlStyle='no-extension'", () => {
    it("omits the trailing slash for non-home pages", () => {
      expect(
        resolveCanonicalUrl({
          siteBaseUrl: "https://example.com",
          pageSlug: "about",
          pageLocale: "en",
          override: null,
          pageUrlStyle: "no-extension",
        }),
      ).toBe("https://example.com/about");
    });

    it("keeps the root URL for the home page", () => {
      expect(
        resolveCanonicalUrl({
          siteBaseUrl: "https://example.com",
          pageSlug: "home",
          pageLocale: "en",
          override: null,
          pageUrlStyle: "no-extension",
        }),
      ).toBe("https://example.com/");
    });

    it("subdirectory locale strategy keeps the locale prefix, no trailing slash on slug", () => {
      expect(
        resolveCanonicalUrl({
          siteBaseUrl: "https://example.com",
          pageSlug: "about",
          pageLocale: "de",
          override: null,
          pageUrlStyle: "no-extension",
          localeConfig: {
            code: "de",
            urlStrategy: "subdirectory",
            urlHost: null,
            isDefault: false,
          },
        }),
      ).toBe("https://example.com/de/about");
    });

    it("default style preserves pre-v0.2.85 trailing-slash behavior", () => {
      expect(
        resolveCanonicalUrl({
          siteBaseUrl: "https://example.com",
          pageSlug: "about",
          pageLocale: "en",
          override: null,
        }),
      ).toBe("https://example.com/about/");
    });
  });
});

describe("renderSeoHead", () => {
  const base = {
    title: "Welcome",
    metaDescription: "A sample description.",
    canonical: "https://example.com/",
    noindex: false,
    ogImageUrl: null,
    hreflang: [] as { locale: string; url: string }[],
    organization: {},
  };

  it("emits canonical + og:type + og:url for the simplest valid input", () => {
    const head = renderSeoHead(base);
    expect(head).toContain("<title>Welcome</title>");
    expect(head).toContain('<meta name="description" content="A sample description." />');
    expect(head).toContain('<link rel="canonical" href="https://example.com/" />');
    expect(head).toContain('<meta property="og:type" content="website" />');
    expect(head).toContain('<meta property="og:url" content="https://example.com/" />');
  });

  it("emits noindex meta only when set", () => {
    expect(renderSeoHead(base)).not.toContain('content="noindex"');
    expect(renderSeoHead({ ...base, noindex: true })).toContain(
      '<meta name="robots" content="noindex" />',
    );
  });

  it("emits og:image and twitter summary_large_image when provided", () => {
    const head = renderSeoHead({ ...base, ogImageUrl: "https://example.com/_assets/x/orig.png" });
    expect(head).toContain(
      '<meta property="og:image" content="https://example.com/_assets/x/orig.png" />',
    );
    expect(head).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  it("emits hreflang per row + x-default when any rows are present", () => {
    const head = renderSeoHead({
      ...base,
      hreflang: [
        { locale: "de", url: "https://example.com/de/" },
        { locale: "fr", url: "https://example.com/fr/" },
      ],
    });
    expect(head).toContain('<link rel="alternate" hreflang="de" href="https://example.com/de/" />');
    expect(head).toContain('<link rel="alternate" hreflang="fr" href="https://example.com/fr/" />');
    expect(head).toContain(
      '<link rel="alternate" hreflang="x-default" href="https://example.com/" />',
    );
  });

  it("emits a JSON-LD WebPage block; encodes the < character to avoid script-tag breaks", () => {
    const head = renderSeoHead({
      ...base,
      title: "Tag <foo>",
      organization: { name: "Caelo Inc.", url: "https://caelo.example" },
    });
    expect(head).toContain('<script type="application/ld+json">');
    expect(head).not.toContain("<foo>"); // angle bracket inside script ld+json should be escaped
    expect(head).toContain('"publisher"');
    expect(head).toContain('"Caelo Inc."');
  });

  it("HTML-encodes attribute values to block injection", () => {
    const head = renderSeoHead({
      ...base,
      title: 'Quote "test"',
      metaDescription: "<script>alert(1)</script>",
    });
    expect(head).toContain('content="Quote &quot;test&quot;"');
    expect(head).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("injectSeoIntoHead", () => {
  it("strips a layout-supplied <title> and injects the head block before </head>", () => {
    const html = "<html><head><title>OldTitle</title></head><body>x</body></html>";
    const out = injectSeoIntoHead(html, "<title>NewTitle</title>");
    expect(out).not.toContain("OldTitle");
    expect(out).toContain("NewTitle");
    expect(out.indexOf("NewTitle")).toBeLessThan(out.indexOf("</head>"));
  });

  it("falls back to prepending when the document has no </head>", () => {
    expect(injectSeoIntoHead("<body>x</body>", "<title>X</title>")).toContain("<title>X</title>");
  });
});

describe("schemas", () => {
  it("seoAutofillInputSchema rejects empty meta description", () => {
    const r = seoAutofillInputSchema.safeParse({
      pageId: "11111111-1111-4111-8111-111111111111",
      metaDescription: "",
    });
    expect(r.success).toBe(false);
  });

  it("seoOptimizeInputSchema accepts context near the cap", () => {
    const r = seoOptimizeInputSchema.safeParse({
      pageId: "11111111-1111-4111-8111-111111111111",
      metaDescription: "A description.",
      context: "x".repeat(3500),
    });
    expect(r.success).toBe(true);
  });

  it("seoOptimizeInputSchema rejects context above the cap", () => {
    const r = seoOptimizeInputSchema.safeParse({
      pageId: "11111111-1111-4111-8111-111111111111",
      metaDescription: "A description.",
      context: "x".repeat(4001),
    });
    expect(r.success).toBe(false);
  });

  it("seoSetInputSchema rejects priority above 1", () => {
    const r = seoSetInputSchema.safeParse({
      pageId: "11111111-1111-4111-8111-111111111111",
      priority: 1.1,
    });
    expect(r.success).toBe(false);
  });

  it("siteDefaultsSetSeoInputSchema rejects non-URL siteBaseUrl", () => {
    const r = siteDefaultsSetSeoInputSchema.safeParse({
      siteBaseUrl: "not a url",
      sitemapEnabled: true,
      organizationJson: {},
    });
    expect(r.success).toBe(false);
  });
});
