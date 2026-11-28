// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { buildPageGraph, LIVE_PLACEHOLDER_KEY } from "./json-ld.js";
import { markNosnippet } from "./module-id-tag.js";
import { renderSeoHead } from "./seo.js";
import {
  ARTICLE_MODIFIED_TIME_PENDING,
  completeSeoOrigins,
  PAGE_SEO_HEAD_DEFAULTS,
  type PageSeoHeadFields,
  type PageSeoHeadSource,
  pageTypeSeoSchema,
  parseSeoTitleVariableMarker,
  renderTitleTemplate,
  resolvePageSeoHead,
  robotsMetaContent,
  seoTitleVariableMarker,
  setArticleModifiedTime,
  titleTemplateIssue,
  titleTemplateVariables,
} from "./seo-head.js";

const SITE = { titleTemplate: "{page_title} | {site_name}", siteName: "Acme" } as const;

function source(o: Partial<PageSeoHeadSource> & { seo?: Partial<PageSeoHeadFields> } = {}) {
  return {
    pageTitle: "Pricing",
    shortTitle: "Prices",
    pageTypeSeo: undefined,
    site: SITE,
    ...o,
    seo: { ...PAGE_SEO_HEAD_DEFAULTS, ...o.seo },
  };
}

describe("title templates", () => {
  it("accepts the documented variables and names what is wrong otherwise", () => {
    expect(titleTemplateIssue("{page_title} | {site_name}")).toBeNull();
    expect(titleTemplateIssue("{short_title} – Blog")).toBeNull();
    expect(titleTemplateIssue("")).toContain("empty");
    expect(titleTemplateIssue("{site_name}")).toContain("{page_title} or {short_title}");
    expect(titleTemplateIssue("{page_title} {term}")).toContain('"{term"');
    expect(titleTemplateIssue("{page_title} }")).toContain("without its `{`");
    expect(titleTemplateIssue("{page_title {site_name}")).not.toBeNull();
    expect(titleTemplateIssue("{page_title}\nx")).toContain("one line");
  });

  it("lists the variables a template uses, once each", () => {
    expect(titleTemplateVariables("{page_title} · {site_name} · {page_title}")).toEqual([
      "page_title",
      "site_name",
    ]);
  });

  it("leaves a variable without a value raw and reports it (no stand-in value)", () => {
    expect(
      renderTitleTemplate("{page_title} | {site_name}", {
        page_title: "Pricing",
        short_title: "Prices",
        site_name: null,
      }),
    ).toEqual({ value: "Pricing | {site_name}", unset: ["site_name"] });
  });

  it("a page type's seo is checked like a written one", () => {
    expect(pageTypeSeoSchema.safeParse({ titleTemplate: "{page_title}" }).success).toBe(true);
    expect(pageTypeSeoSchema.safeParse({ titleTemplate: "Blog" }).success).toBe(false);
    expect(pageTypeSeoSchema.safeParse({ ogType: "video" }).success).toBe(false);
  });
});

describe("resolvePageSeoHead — site → page type → page", () => {
  it("a page without its own SEO title gets the site's template", () => {
    const head = resolvePageSeoHead(source());
    expect(head.title).toEqual({
      value: "Pricing | Acme",
      origin: "site",
      template: "{page_title} | {site_name}",
    });
  });

  it("its page type's template wins over the site's", () => {
    const head = resolvePageSeoHead(
      source({ pageTypeSeo: { titleTemplate: "{short_title} – Blog | {site_name}" } }),
    );
    expect(head.title).toEqual({
      value: "Prices – Blog | Acme",
      origin: "page_type",
      template: "{short_title} – Blog | {site_name}",
    });
  });

  it("the page's own SEO title wins over every template, with its authorship", () => {
    const head = resolvePageSeoHead(
      source({
        pageTypeSeo: { titleTemplate: "{page_title} – Blog" },
        seo: { seoTitle: "Plans for every team", origins: { seoTitle: "reviewed" } },
      }),
    );
    expect(head.title).toEqual({
      value: "Plans for every team",
      origin: "reviewed",
      template: null,
    });
  });

  it("og:title shares the SEO title, else the page title; og:description the description", () => {
    const plain = resolvePageSeoHead(source());
    expect(plain.ogTitle).toEqual({
      value: "Pricing",
      origin: "inherited",
      inheritsFrom: "pageTitle",
    });
    expect(plain.ogDescription).toEqual({ value: "", origin: "unset", inheritsFrom: null });
    expect(plain.metaDescription).toEqual({ value: "", origin: "unset" });
    const own = resolvePageSeoHead(
      source({
        seo: {
          seoTitle: "Plans",
          metaDescription: "Fair prices.",
          origins: { seoTitle: "ai", metaDescription: "human" },
        },
      }),
    );
    expect(own.ogTitle).toEqual({ value: "Plans", origin: "inherited", inheritsFrom: "seoTitle" });
    expect(own.ogDescription).toEqual({
      value: "Fair prices.",
      origin: "inherited",
      inheritsFrom: "metaDescription",
    });
    const overridden = resolvePageSeoHead(
      source({
        seo: {
          ogTitle: "Share me",
          ogDescription: "Look",
          origins: { ogTitle: "human", ogDescription: "ai" },
        },
      }),
    );
    expect(overridden.ogTitle).toEqual({ value: "Share me", origin: "human", inheritsFrom: null });
    expect(overridden.ogDescription).toEqual({ value: "Look", origin: "ai", inheritsFrom: null });
  });

  it("og:type comes from the page type, else the site's website", () => {
    expect(resolvePageSeoHead(source()).ogType).toEqual({ value: "website", origin: "site" });
    expect(resolvePageSeoHead(source({ pageTypeSeo: { ogType: "article" } })).ogType).toEqual({
      value: "article",
      origin: "page_type",
    });
  });

  it("reports a template variable without a value", () => {
    const head = resolvePageSeoHead(source({ site: { ...SITE, siteName: null } }));
    expect(head.title.value).toBe("Pricing | {site_name}");
    expect(head.unsetVariables).toEqual(["site_name"]);
    expect(parseSeoTitleVariableMarker(seoTitleVariableMarker("site_name"))).toBe("site_name");
    expect(parseSeoTitleVariableMarker("og-image-missing:page/x")).toBeNull();
  });

  it("forces noindex for the 404 and follow-up pages, keeping the other directives", () => {
    const head = resolvePageSeoHead(source({ seo: { nofollow: true }, forceNoindex: true }));
    expect(robotsMetaContent(head.robots)).toBe("noindex, nofollow, max-image-preview:large");
  });

  it("refuses an own text without a recorded authorship (a reader skipped completeSeoOrigins)", () => {
    expect(() => resolvePageSeoHead(source({ seo: { seoTitle: "x" } }))).toThrow(
      /completeSeoOrigins/,
    );
  });
});

describe("robotsMetaContent", () => {
  it("renders every directive in one fixed order", () => {
    expect(
      robotsMetaContent({
        noindex: true,
        nofollow: true,
        noarchive: true,
        nosnippet: true,
        noimageindex: true,
        maxSnippet: 50,
        maxImagePreview: "standard",
        maxVideoPreview: -1,
      }),
    ).toBe(
      "noindex, nofollow, noarchive, nosnippet, noimageindex, max-snippet:50, max-image-preview:standard, max-video-preview:-1",
    );
    expect(robotsMetaContent(PAGE_SEO_HEAD_DEFAULTS)).toBe("max-image-preview:large");
  });
});

describe("completeSeoOrigins", () => {
  const texts = { seoTitle: "", metaDescription: "D", ogTitle: "T", ogDescription: "" };
  it("keeps recorded authorships and records none for empty texts", () => {
    expect(
      completeSeoOrigins({
        ...texts,
        origins: { metaDescription: "reviewed", seoTitle: "ai" },
        autofilledAt: null,
        optimizedAt: null,
      }),
    ).toEqual({ metaDescription: "reviewed", ogTitle: "human" });
  });
  it("gives an unrecorded text 0894's rule: AI once SEO was autofilled or optimized", () => {
    expect(
      completeSeoOrigins({
        ...texts,
        origins: null,
        autofilledAt: "2026-01-01T00:00:00Z",
        optimizedAt: null,
      }),
    ).toEqual({ metaDescription: "ai", ogTitle: "ai" });
  });
});

describe("renderSeoHead (#1752)", () => {
  const head = (o: Parameters<typeof source>[0] = {}) => resolvePageSeoHead(source(o));
  /** #1753 — the page's graph, with its live dates when it has them. */
  const graph = (liveDates: { published: string; modified: string } | null = null) =>
    buildPageGraph(
      {
        siteBaseUrl: "https://acme.example",
        canonical: "https://acme.example/pricing/",
        siteName: "Acme",
        siteLanguage: "en",
        pageLanguage: "en",
        pageTitle: "Pricing",
        description: "",
        imageUrl: null,
        organization: {},
        breadcrumbs: [],
        liveDates,
      },
      [
        {
          plugin: "seo",
          webPage: {},
          nodes: [
            {
              "@type": "Article",
              "@id": "https://acme.example/pricing/#article",
              dateModified: { [LIVE_PLACEHOLDER_KEY]: "modified" },
            },
          ],
        },
      ],
      () => null,
    ).graph;
  const input = {
    pageTitle: "Pricing",
    siteName: "Acme",
    article: null,
    canonical: "https://acme.example/pricing/",
    ogImageUrl: null,
    feed: null,
    jsonLd: graph(),
  };

  it("renders the resolved title, og overrides, og:site_name and the page title as JSON-LD name", () => {
    const html = renderSeoHead({
      ...input,
      head: head({
        seo: { ogTitle: "Share <me>", origins: { ogTitle: "human" } },
      }),
    });
    expect(html).toContain("<title>Pricing | Acme</title>");
    expect(html).toContain('<meta property="og:title" content="Share &lt;me&gt;" />');
    expect(html).toContain('<meta property="og:site_name" content="Acme" />');
    expect(html).toContain('"name":"Pricing"');
  });

  it("dates an article only, and the build's pending date is replaced in place", () => {
    const article = {
      publishedTime: "2026-01-02T00:00:00.000Z",
      modifiedTime: ARTICLE_MODIFIED_TIME_PENDING,
    };
    expect(renderSeoHead({ ...input, head: head(), article })).not.toContain("article:");
    const html = renderSeoHead({
      ...input,
      head: head({ pageTypeSeo: { ogType: "article" } }),
      article,
    });
    expect(html).toContain('<meta property="og:type" content="article" />');
    expect(html).toContain(
      '<meta property="article:published_time" content="2026-01-02T00:00:00.000Z" />',
    );
    const dated = setArticleModifiedTime(html, "2026-03-04T05:06:07.000Z");
    expect(dated).not.toContain(ARTICLE_MODIFIED_TIME_PENDING);
    expect(dated).toContain(
      '<meta property="article:modified_time" content="2026-03-04T05:06:07.000Z" />',
    );
    expect(setArticleModifiedTime("<html></html>", "x")).toBe("<html></html>");
  });

  it("keeps the graph's publication date when it equals the modified date it re-dates (#1753)", () => {
    // Right after the first publish both dates are the same instant.
    const first = "2026-01-02T00:00:00.000Z";
    const html = renderSeoHead({
      ...input,
      head: head({ pageTypeSeo: { ogType: "article" } }),
      article: { publishedTime: first, modifiedTime: first },
      jsonLd: graph({ published: first, modified: first }),
    });
    const dated = setArticleModifiedTime(html, "2026-03-04T05:06:07.000Z");
    const nodes = (
      JSON.parse(
        /<script type="application\/ld\+json">(.*?)<\/script>/.exec(dated)?.[1] ?? "{}",
      ) as { "@graph": Record<string, unknown>[] }
    )["@graph"];
    const dated2 = nodes.filter((n) => n.dateModified !== undefined);
    expect(dated2.length).toBeGreaterThan(0);
    for (const n of dated2) {
      expect(n.dateModified).toBe("2026-03-04T05:06:07.000Z");
      if (n.datePublished !== undefined) expect(n.datePublished).toBe(first);
    }
    expect(dated).toContain(`<meta property="article:published_time" content="${first}" />`);
  });

  it("dates the JSON-LD graph's live modified date with the article's, and again later (#1753)", () => {
    const html = renderSeoHead({
      ...input,
      head: head({ pageTypeSeo: { ogType: "article" } }),
      article: {
        publishedTime: "2026-01-02T00:00:00.000Z",
        modifiedTime: ARTICLE_MODIFIED_TIME_PENDING,
      },
      jsonLd: graph({
        published: "2026-01-02T00:00:00.000Z",
        modified: ARTICLE_MODIFIED_TIME_PENDING,
      }),
    });
    expect(html.match(new RegExp(ARTICLE_MODIFIED_TIME_PENDING, "g"))).toHaveLength(3);
    const dated = setArticleModifiedTime(html, "2026-03-04T05:06:07.000Z");
    expect(dated).not.toContain(ARTICLE_MODIFIED_TIME_PENDING);
    // The WebPage's and the plugin node's dateModified, and the meta.
    expect(dated.match(/2026-03-04T05:06:07\.000Z/g)).toHaveLength(3);
    // A plugin-data build moves the date again: the graph follows.
    const again = setArticleModifiedTime(dated, "2026-05-06T07:08:09.000Z");
    expect(again).not.toContain("2026-03-04T05:06:07.000Z");
    expect(again.match(/2026-05-06T07:08:09\.000Z/g)).toHaveLength(3);
    // A page without article meta (og:type website) still gets its graph dated.
    const website = renderSeoHead({
      ...input,
      head: head(),
      jsonLd: graph({
        published: "2026-01-02T00:00:00.000Z",
        modified: ARTICLE_MODIFIED_TIME_PENDING,
      }),
    });
    const websiteDated = setArticleModifiedTime(website, "2026-03-04T05:06:07.000Z");
    expect(websiteDated).not.toContain(ARTICLE_MODIFIED_TIME_PENDING);
    expect(websiteDated.match(/2026-03-04T05:06:07\.000Z/g)).toHaveLength(2);
  });
});

describe("markNosnippet", () => {
  it("marks a div, section or span root, and wraps any other root", () => {
    expect(markNosnippet('<section class="a">x</section>')).toBe(
      '<section class="a" data-nosnippet="">x</section>',
    );
    expect(markNosnippet("<article>x</article>")).toBe(
      '<div data-nosnippet=""><article>x</article></div>',
    );
    const once = markNosnippet("<article>x</article>");
    expect(markNosnippet(once)).toBe(once);
    // A text-only placement is wrapped too (review #1771); an empty one stays empty.
    expect(markNosnippet("plain text")).toBe('<div data-nosnippet="">plain text</div>');
    expect(markNosnippet("  ")).toBe("  ");
    // The parsed root is stamped, never markup inside a comment (review #1771).
    expect(markNosnippet("<!-- <div>example</div> --><section>Sensitive</section>")).toBe(
      '<!-- <div>example</div> --><section data-nosnippet="">Sensitive</section>',
    );
    expect(markNosnippet("<!-- <div data-nosnippet> --><section>x</section>")).toBe(
      '<!-- <div data-nosnippet> --><section data-nosnippet="">x</section>',
    );
    expect(markNosnippet("<!-- only a note -->")).toBe("<!-- only a note -->");
    // Only the attribute itself counts, not a longer name or a value (review #1771).
    expect(markNosnippet('<div data-nosnippet-disabled="true">x</div>')).toBe(
      '<div data-nosnippet-disabled="true" data-nosnippet="">x</div>',
    );
    expect(markNosnippet('<div title=" data-nosnippet=">x</div>')).toBe(
      '<div title=" data-nosnippet=" data-nosnippet="">x</div>',
    );
    expect(markNosnippet('<span title="a>b">x</span>')).toBe(
      '<span title="a>b" data-nosnippet="">x</span>',
    );
    expect(markNosnippet("<div data-nosnippet>x</div>")).toBe("<div data-nosnippet>x</div>");
    // An unsupported root that carries the attribute is still wrapped (review #1771).
    expect(markNosnippet('<article data-nosnippet="">x</article>')).toBe(
      '<div data-nosnippet=""><article data-nosnippet="">x</article></div>',
    );
  });

  it("wraps a placement of several top-level elements whole (review #1771)", () => {
    expect(markNosnippet("<section>First</section><p>Sensitive</p>")).toBe(
      '<div data-nosnippet=""><section>First</section><p>Sensitive</p></div>',
    );
    expect(markNosnippet("<div>a</div> loose text")).toBe(
      '<div data-nosnippet=""><div>a</div> loose text</div>',
    );
    // A comment and whitespace around one root still leave it the root.
    expect(markNosnippet("<!-- note -->\n<div><p>a</p><p>b</p></div>\n")).toBe(
      '<!-- note -->\n<div data-nosnippet=""><p>a</p><p>b</p></div>\n',
    );
  });
});
