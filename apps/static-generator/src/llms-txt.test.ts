// SPDX-License-Identifier: MPL-2.0

/** #1763 — the llms.txt file as core writes it. */

import { describe, expect, it } from "bun:test";
import { type LlmsTxtPage, renderLlmsTxt } from "./llms-txt.js";

const page = (n: number, pageType: string, over: Partial<LlmsTxtPage> = {}): LlmsTxtPage => ({
  pageId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  url: `https://example.com/p${n}/`,
  title: `Page ${n}`,
  metaDescription: `About page ${n}.`,
  pageType,
  ...over,
});

describe("renderLlmsTxt", () => {
  it("writes the site, its summary and a section per page type", () => {
    expect(
      renderLlmsTxt({
        siteName: "Example",
        summary: "What the site is about.",
        pages: [page(1, "Guide"), page(2, "Article"), page(3, "Guide", { metaDescription: "" })],
        sitemapUrl: "https://example.com/sitemap.xml",
      }),
    ).toBe(
      [
        "# Example",
        "",
        "> What the site is about.",
        "",
        "## Article",
        "",
        "- [Page 2](https://example.com/p2/): About page 2.",
        "",
        "## Guide",
        "",
        "- [Page 1](https://example.com/p1/): About page 1.",
        "- [Page 3](https://example.com/p3/)",
        "",
      ].join("\n"),
    );
  });

  it("keeps every value on one line and inside its link", () => {
    const text = renderLlmsTxt({
      siteName: "Ex\nample",
      summary: "",
      pages: [
        page(1, "Guide\n## Injected", {
          title: "A [b] \\ c\n# heading",
          url: "https://example.com/a (b)/",
          metaDescription: "one\n\n- [evil](https://evil.example)",
        }),
      ],
      sitemapUrl: null,
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("# Ex ample");
    expect(lines).toContain("## Guide ## Injected");
    expect(text).toContain(
      "- [A \\[b\\] \\\\ c # heading](https://example.com/a%20%28b%29/): one - [evil](https://evil.example)",
    );
    // Only the headings and entries the renderer writes start a line.
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(1);
  });

  it("stays under its size cap and points at the sitemap for the rest", () => {
    const pages = Array.from({ length: 500 }, (_, i) => page(i, "Article"));
    const text = renderLlmsTxt({
      siteName: "Example",
      summary: "",
      pages,
      sitemapUrl: "https://example.com/sitemap.xml",
      maxBytes: 4000,
    });
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(4000);
    expect(text).toContain("## More");
    expect(text.trimEnd().endsWith("(https://example.com/sitemap.xml): the sitemap")).toBe(true);
    const all = renderLlmsTxt({ siteName: "Example", summary: "", pages, sitemapUrl: null });
    expect(all).not.toContain("## More");
  });
});
