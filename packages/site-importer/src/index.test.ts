// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { crawlSite } from "./crawler.js";
import { extractModulesFromHtml, extractThemeTokens, extractTitle } from "./extractor.js";
import { computeDiffStatus } from "./screenshot-diff.js";

describe("extractor", () => {
  it("extracts <title>", () => {
    expect(extractTitle("<html><head><title>  Hello  </title></head></html>")).toBe("Hello");
  });

  it("splits header / sections / footer", () => {
    const html = `
      <html><body>
        <header>NAV</header>
        <section>S1</section>
        <section>S2</section>
        <footer>FOO</footer>
      </body></html>
    `;
    const mods = extractModulesFromHtml(html);
    expect(mods.length).toBe(4);
    expect(mods.find((m) => m.blockName === "header")).toBeDefined();
    expect(mods.find((m) => m.blockName === "footer")).toBeDefined();
    expect(mods.filter((m) => m.blockName === "content").length).toBe(2);
  });

  it("falls back to a single content block when no semantic tags", () => {
    const mods = extractModulesFromHtml("<html><body><div>just a div</div></body></html>");
    expect(mods.length).toBe(1);
    expect(mods[0]?.blockName).toBe("content");
  });

  it("pulls :root css custom-properties", () => {
    const tokens = extractThemeTokens(
      "<style>:root { --color-primary: #2563eb; --font-body: sans-serif; }</style>",
    );
    expect(tokens["--color-primary"]).toBe("#2563eb");
    expect(tokens["--font-body"]).toBe("sans-serif");
  });
});

describe("crawler", () => {
  it("BFS within the same host, respects depth + maxPages", async () => {
    // Synthetic in-memory site: root → /a → /b
    const pages: Record<string, string> = {
      "https://test.local/": '<html><body><a href="/a">A</a></body></html>',
      "https://test.local/a": '<html><body><a href="/b">B</a></body></html>',
      "https://test.local/b": "<html><body><p>leaf</p></body></html>",
      "https://other.local/x": "<html><body>off-domain</body></html>",
    };
    const result = await crawlSite({
      sourceUrl: "https://test.local/",
      depth: 2,
      maxPages: 10,
      throttleMs: 0,
      fetcher: async (url: string) => ({
        ok: pages[url] !== undefined,
        html: pages[url] ?? "",
        contentType: "text/html",
      }),
    });
    const slugs = result.pages.map((p) => p.proposedSlug).sort();
    expect(slugs).toEqual(["a", "b", "home"]);
  });

  it("declines off-domain redirects", async () => {
    const pages: Record<string, string> = {
      "https://test.local/": '<html><body><a href="https://other.local/x">off</a></body></html>',
    };
    const result = await crawlSite({
      sourceUrl: "https://test.local/",
      depth: 2,
      maxPages: 10,
      throttleMs: 0,
      fetcher: async (url: string) => ({
        ok: pages[url] !== undefined,
        html: pages[url] ?? "",
        contentType: "text/html",
      }),
    });
    expect(result.pages.length).toBe(1);
  });
});

describe("screenshot-diff classifier", () => {
  it("buckets 0.02 → pass", () => {
    expect(computeDiffStatus(0.02).status).toBe("pass");
  });
  it("buckets 0.10 → warn", () => {
    expect(computeDiffStatus(0.1).status).toBe("warn");
  });
  it("buckets 0.30 → fail", () => {
    expect(computeDiffStatus(0.3).status).toBe("fail");
  });
  it("guards against bad inputs", () => {
    expect(computeDiffStatus(-1).status).toBe("fail");
    expect(computeDiffStatus(Number.NaN).status).toBe("fail");
  });
});
