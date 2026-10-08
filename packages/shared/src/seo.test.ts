// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  checkPublicSiteBaseUrl,
  injectSeoIntoHead,
  renderSeoHead,
  resolveCanonicalUrl,
  seoAutofillInputSchema,
  seoOptimizeInputSchema,
  seoSetInputSchema,
  siteDefaultsSetSeoInputSchema,
  siteSeoProposalInputSchema,
} from "./seo.js";

describe("resolveCanonicalUrl", () => {
  it("uses the explicit override when provided", () => {
    expect(
      resolveCanonicalUrl({
        siteBaseUrl: "https://example.com",
        pagePath: "/anything",
        override: "https://canonical.example.com/x",
        pageUrlStyle: "directory",
        host: "de.example.com",
      }),
    ).toBe("https://canonical.example.com/x");
  });

  it("renders the composed root path as the bare base URL", () => {
    expect(
      resolveCanonicalUrl({
        siteBaseUrl: "https://example.com",
        pagePath: "/",
        override: null,
        pageUrlStyle: "directory",
      }),
    ).toBe("https://example.com/");
  });

  it("trims trailing slash on the base URL", () => {
    expect(
      resolveCanonicalUrl({
        siteBaseUrl: "https://example.com/",
        pagePath: "/about",
        override: null,
        pageUrlStyle: "directory",
      }),
    ).toBe("https://example.com/about/");
  });

  describe("#590 — composed host (host-strategy locales)", () => {
    for (const [style, expected] of [
      ["directory", "https://de.example.com/preise/"],
      ["no-extension", "https://de.example.com/preise"],
    ] as const) {
      it(`swaps the host, keeps the base scheme and the ${style} slash rule`, () => {
        expect(
          resolveCanonicalUrl({
            siteBaseUrl: "https://example.com/",
            pagePath: "/preise",
            override: null,
            pageUrlStyle: style,
            host: "de.example.com",
          }),
        ).toBe(expected);
      });
    }

    it("a null host keeps the site base host", () => {
      expect(
        resolveCanonicalUrl({
          siteBaseUrl: "https://example.com",
          pagePath: "/",
          override: null,
          pageUrlStyle: "no-extension",
          host: null,
        }),
      ).toBe("https://example.com/");
    });
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

    it("'directory' keeps the trailing slash for non-home pages", () => {
      expect(
        resolveCanonicalUrl({
          siteBaseUrl: "https://example.com",
          pagePath: "/about",
          override: null,
          pageUrlStyle: "directory",
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

  it("#551: omits canonical, og:url and the JSON-LD url when the base URL is unset", () => {
    const head = renderSeoHead({ ...base, canonical: null });
    expect(head).not.toContain('rel="canonical"');
    expect(head).not.toContain("og:url");
    expect(head).not.toContain('"url"');
    expect(head).toContain("<title>Welcome</title>");
  });

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

describe("siteSeoProposalInputSchema", () => {
  it("accepts any single field", () => {
    expect(siteSeoProposalInputSchema.safeParse({ siteBaseUrl: "https://a.example" }).success).toBe(
      true,
    );
    expect(siteSeoProposalInputSchema.safeParse({ sitemapEnabled: false }).success).toBe(true);
    expect(
      siteSeoProposalInputSchema.safeParse({ organizationJson: { name: "Acme" } }).success,
    ).toBe(true);
  });

  it("rejects an empty proposal with a message naming the fields", () => {
    const r = siteSeoProposalInputSchema.safeParse({});
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("siteBaseUrl");
  });

  it("rejects unknown keys at the top level and inside organizationJson", () => {
    expect(siteSeoProposalInputSchema.safeParse({ sitemapEnabled: true, x: 1 }).success).toBe(
      false,
    );
    expect(
      siteSeoProposalInputSchema.safeParse({ organizationJson: { name: "A", script: "<x>" } })
        .success,
    ).toBe(false);
  });
});

describe("checkPublicSiteBaseUrl", () => {
  it("normalises a valid https URL to its origin", () => {
    expect(checkPublicSiteBaseUrl("https://www.Example.com/", "gcp")).toEqual({
      ok: true,
      url: "https://www.example.com",
    });
    expect(checkPublicSiteBaseUrl(" https://example.com:8443 ", undefined)).toEqual({
      ok: true,
      url: "https://example.com:8443",
    });
  });

  it("rejects a path, query or fragment and names the origin to use instead", () => {
    for (const raw of [
      "https://example.com/blog",
      "https://example.com/?a=1",
      "https://example.com/#top",
    ]) {
      const r = checkPublicSiteBaseUrl(raw, "aws");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("use https://example.com");
    }
  });

  it("rejects non-URLs and credentials", () => {
    expect(checkPublicSiteBaseUrl("example.com", "gcp").ok).toBe(false);
    expect(checkPublicSiteBaseUrl("https://u:p@example.com", "gcp").ok).toBe(false);
  });

  it("requires https for public hosts on every provider", () => {
    expect(checkPublicSiteBaseUrl("http://example.com", "gcp").ok).toBe(false);
    expect(checkPublicSiteBaseUrl("http://example.com", "self-hosted").ok).toBe(false);
    expect(checkPublicSiteBaseUrl("ftp://example.com", undefined).ok).toBe(false);
  });

  it("rejects loopback hosts on cloud providers", () => {
    for (const provider of ["gcp", "gcp-firebase", "aws", "azure"]) {
      for (const raw of [
        "https://localhost",
        "http://localhost:8082",
        "https://127.0.0.1",
        "https://[::1]",
        "https://app.localhost",
      ]) {
        const r = checkPublicSiteBaseUrl(raw, provider);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.message).toContain("public domain");
      }
    }
  });

  it("allows http://localhost on a self-hosted install (local dev)", () => {
    expect(checkPublicSiteBaseUrl("http://localhost:8082", undefined)).toEqual({
      ok: true,
      url: "http://localhost:8082",
    });
    expect(checkPublicSiteBaseUrl("http://127.0.0.1:8082", "self-hosted").ok).toBe(true);
  });

  it("rejects wildcard bind addresses on every provider, self-hosted included", () => {
    for (const provider of [undefined, "self-hosted", "gcp"]) {
      for (const raw of ["http://0.0.0.0:8082", "https://0.0.0.0", "http://[::]:8082"]) {
        const r = checkPublicSiteBaseUrl(raw, provider);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.message).toContain("bind address");
      }
    }
  });
});
