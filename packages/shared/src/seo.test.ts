// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  injectSeoIntoHead,
  isLoopbackBaseUrl,
  localSiteBaseUrlError,
  renderSeoHead,
  resolveCanonicalUrl,
  seoAutofillInputSchema,
  seoOptimizeInputSchema,
  seoSetInputSchema,
  siteBaseUrlToSeed,
  siteDefaultsSetSeoInputSchema,
} from "./seo.js";

describe("resolveCanonicalUrl", () => {
  it("uses the explicit override when provided", () => {
    expect(
      resolveCanonicalUrl({
        siteBaseUrl: "https://example.com",
        pagePath: "/anything",
        override: "https://canonical.example.com/x",
      }),
    ).toBe("https://canonical.example.com/x");
  });

  it("renders the composed root path as the bare base URL", () => {
    expect(
      resolveCanonicalUrl({
        siteBaseUrl: "https://example.com",
        pagePath: "/",
        override: null,
      }),
    ).toBe("https://example.com/");
  });

  it("trims trailing slash on the base URL", () => {
    expect(
      resolveCanonicalUrl({
        siteBaseUrl: "https://example.com/",
        pagePath: "/about",
        override: null,
      }),
    ).toBe("https://example.com/about/");
  });

  describe("v0.2.85 — pageUrlStyle='no-extension'", () => {
    it("omits the trailing slash for non-home pages", () => {
      expect(
        resolveCanonicalUrl({
          siteBaseUrl: "https://example.com",
          pagePath: "/about",
          override: null,
          pageUrlStyle: "no-extension",
        }),
      ).toBe("https://example.com/about");
    });

    it("keeps the root URL for the composed root path", () => {
      expect(
        resolveCanonicalUrl({
          siteBaseUrl: "https://example.com",
          pagePath: "/",
          override: null,
          pageUrlStyle: "no-extension",
        }),
      ).toBe("https://example.com/");
    });

    it("default style preserves pre-v0.2.85 trailing-slash behavior", () => {
      expect(
        resolveCanonicalUrl({
          siteBaseUrl: "https://example.com",
          pagePath: "/about",
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

// Regression: provisioned installs shipped canonical / og:url / JSON-LD /
// sitemap / robots.txt pointing at the migration's dev default
// `http://localhost:8082`, in staging and production alike.
describe("isLoopbackBaseUrl", () => {
  it("flags local addresses", () => {
    for (const url of [
      "http://localhost:8082",
      "http://LOCALHOST",
      "http://site.localhost:3000/",
      "http://127.0.0.1:8082",
      "http://127.10.0.5",
      "http://[::1]:8082",
      "http://0.0.0.0:8082",
    ]) {
      expect(isLoopbackBaseUrl(url)).toBe(true);
    }
  });

  it("accepts public hosts, including ones that merely contain 'localhost'", () => {
    for (const url of [
      "https://example.com",
      "https://localhost.example.com",
      "https://127.example.com",
      "http://10.0.0.1",
    ]) {
      expect(isLoopbackBaseUrl(url)).toBe(false);
    }
  });

  it("is false for a non-URL", () => {
    expect(isLoopbackBaseUrl("not a url")).toBe(false);
  });
});

describe("siteBaseUrlToSeed", () => {
  it("replaces the migration's dev default with the declared public URL", () => {
    expect(siteBaseUrlToSeed("http://localhost:8082", "https://example.com")).toBe(
      "https://example.com",
    );
  });

  it("never overwrites an operator-set public URL", () => {
    expect(siteBaseUrlToSeed("https://www.example.com", "https://example.com")).toBeNull();
  });

  it("does nothing without a usable declared public URL", () => {
    expect(siteBaseUrlToSeed("http://localhost:8082", undefined)).toBeNull();
    expect(siteBaseUrlToSeed("http://localhost:8082", "  ")).toBeNull();
    expect(siteBaseUrlToSeed("http://localhost:8082", "example.com")).toBeNull();
    expect(siteBaseUrlToSeed("http://localhost:8082", "ftp://example.com")).toBeNull();
    expect(siteBaseUrlToSeed("http://localhost:8082", "http://localhost:8082")).toBeNull();
  });

  it("trims the declared URL", () => {
    expect(siteBaseUrlToSeed("http://127.0.0.1", " https://example.com ")).toBe(
      "https://example.com",
    );
  });
});

describe("localSiteBaseUrlError", () => {
  it("fails a cloud build whose base URL is still localhost", () => {
    for (const provider of ["gcp", "gcp-firebase", "aws", "azure"]) {
      const msg = localSiteBaseUrlError({
        siteBaseUrl: "http://localhost:8082",
        provider,
        declaredSiteBaseUrl: undefined,
      });
      expect(msg).toContain("http://localhost:8082");
      expect(msg).toContain("cms-provision upgrade");
    }
  });

  it("fails any install that declares a public URL but still stores localhost", () => {
    const msg = localSiteBaseUrlError({
      siteBaseUrl: "http://localhost:8082",
      provider: undefined,
      declaredSiteBaseUrl: "https://example.com",
    });
    expect(msg).toContain("CAELO_SITE_BASE_URL=https://example.com");
  });

  it("lets a local dev box build against localhost", () => {
    for (const provider of [undefined, "self-hosted"]) {
      expect(
        localSiteBaseUrlError({
          siteBaseUrl: "http://localhost:8082",
          provider,
          declaredSiteBaseUrl: undefined,
        }),
      ).toBeNull();
    }
    expect(
      localSiteBaseUrlError({
        siteBaseUrl: "http://localhost:8082",
        provider: undefined,
        declaredSiteBaseUrl: "http://localhost:8082",
      }),
    ).toBeNull();
  });

  it("passes a public base URL everywhere", () => {
    expect(
      localSiteBaseUrlError({
        siteBaseUrl: "https://example.com",
        provider: "gcp-firebase",
        declaredSiteBaseUrl: "https://example.com",
      }),
    ).toBeNull();
  });
});
