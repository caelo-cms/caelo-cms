// SPDX-License-Identifier: MPL-2.0

/**
 * issue #189 / #278 — single-page external sensing tools. Runs against a
 * real local Bun.serve fixture (no mocked HTTP) with the SSRF guard's
 * allowedHosts exemption scoped to the fixture host; blocked-URL cases
 * exercise the REAL guard. Covers the facet-selectable inspect tool + the
 * homepage-driven page-type map (#278).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Screenshot } from "@caelo-cms/site-importer";
import { resetExternalFetchBudgetForTests } from "../tools/_external-fetch-budget.js";
import { setExternalScreenshotterForTests } from "../tools/_external-screenshotter.js";
import type { ToolContext } from "../tools/dispatch.js";
import { clearPageInspectionCacheForTests } from "../tools/_page-inspection-cache.js";
import { extractStylesheetHrefs, inspectExternalPageTool } from "../tools/inspect-external-page.js";
import { mapExternalPageTypesTool } from "../tools/map-external-page-types.js";
import { keywordWindows, queryPageHtmlTool } from "../tools/query-page-html.js";
import { readPageMoreTool } from "../tools/read-page-more.js";
import { screenshotExternalPageTool } from "../tools/screenshot-external-page.js";

const FIXTURE_HTML = `<!doctype html><html lang="en"><head>
<title>Bergbäckerei Steinofen</title>
<meta name="description" content="Handgemachtes Sauerteigbrot aus Freiburg">
<link rel="canonical" href="/en/">
<link rel="alternate" hreflang="de" href="/de/">
<link rel="stylesheet" href="/styles/main.css">
<style>.hero { background: linear-gradient(135deg, #7c2d12, #f59e0b); }</style>
</head><body>
<header><nav>
  <a href="/en/pricing">Preise</a>
  <a href="/en/blog">Blog</a>
  <a href="/en/use-cases">Anwendungen</a>
  <a href="/de/preise">DE Preise</a>
  <a href="https://instagram.com/x">IG</a>
  <a href="#top">Top</a>
</nav></header>
<main>
<h1>Bergbäckerei Steinofen</h1>
<h2>Unser Brot</h2>
<h3>Öffnungszeiten</h3>
<img src="/img/brot.jpg" alt="Frisches Sauerteigbrot">
<button aria-label="Menü öffnen">≡</button>
<section>Willkommen</section>
</main>
<footer><a href="/en/impressum">Impressum</a></footer>
</body></html>`;

const FIXTURE_CSS = `body { color: #1c1917; background: #fef3c7; font-family: "Fraunces", serif; }
h1 { font-size: 3rem; color: #7c2d12; }`;

let server: ReturnType<typeof Bun.serve>;
let base: string;
const savedAllowed = process.env.CAELO_IMPORTER_ALLOWED_HOSTS;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/" || path === "/en" || path === "/en/") {
        return new Response(FIXTURE_HTML, { headers: { "content-type": "text/html" } });
      }
      if (path === "/styles/main.css") {
        return new Response(FIXTURE_CSS, { headers: { "content-type": "text/css" } });
      }
      if (path === "/sitemap.xml") {
        const u = (p: string) => `<url><loc>${base}${p}</loc></url>`;
        return new Response(
          `<?xml version="1.0"?><urlset>${u("/en/blog/post-1")}${u("/en/blog/post-2")}${u("/en/tools/checker")}${u("/en/tag/seo")}${u("/en/2023/05/old")}${u("/de/blog/x")}</urlset>`,
          { headers: { "content-type": "application/xml" } },
        );
      }
      return new Response("nope", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  process.env.CAELO_IMPORTER_ALLOWED_HOSTS = "127.0.0.1";
});

afterAll(() => {
  server.stop(true);
  if (savedAllowed === undefined) delete process.env.CAELO_IMPORTER_ALLOWED_HOSTS;
  else process.env.CAELO_IMPORTER_ALLOWED_HOSTS = savedAllowed;
});

afterEach(() => {
  resetExternalFetchBudgetForTests();
  setExternalScreenshotterForTests(null);
});

const toolCtx = { chatSessionId: "11111111-1111-4111-8111-111111111111" } as ToolContext;
const emptyCtx = {
  actorId: "22222222-2222-4222-8222-222222222222",
  actorKind: "ai" as const,
  requestId: "test",
};

describe("inspect_external_page — facet selection", () => {
  it("gist default = meta + markdown + a pageRef; links/markup/etc stay off", async () => {
    const r = await inspectExternalPageTool.handler(emptyCtx, { url: `${base}/` }, toolCtx);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("Facets: meta, markdown");
    expect(r.content).toContain("## Meta");
    expect(r.content).toContain("## Page text (Markdown)");
    // Markdown carries the readable structure (heading text, not raw tags).
    expect(r.content).toContain("# Bergbäckerei Steinofen");
    expect(r.content).not.toContain("<h1>");
    // A reuse handle is surfaced.
    expect(r.content).toMatch(/Page handle: pg_\w+/);
    // links is OPT-IN now: a 200+-link page must not bloat every inspect.
    expect(r.content).not.toContain("## Outbound links");
    // …and definitely not markup / tokens / screenshot.
    expect(r.content).not.toContain("## Markup");
    expect(r.content).not.toContain("## Design fact base");
  });

  it("read_page_more reuses the pageRef to paginate — no re-fetch", async () => {
    clearPageInspectionCacheForTests();
    const first = await inspectExternalPageTool.handler(
      emptyCtx,
      { url: `${base}/`, facets: { markdown: true } },
      toolCtx,
    );
    expect(first.ok).toBe(true);
    const pageRef = /Page handle: (pg_\w+)/.exec(first.content ?? "")?.[1];
    expect(pageRef).toBeDefined();
    // Continue from an offset; the fixture is short so this returns the
    // end-of-page marker but must NOT error and must NOT spend fetch budget.
    const more = await readPageMoreTool.handler(emptyCtx, { pageRef: pageRef!, cursor: 0 }, toolCtx);
    expect(more.ok).toBe(true);
    expect(more.content).toContain("Page text (Markdown)");
    // An unknown handle fails cleanly (points back at inspect_external_page).
    const missing = await readPageMoreTool.handler(emptyCtx, { pageRef: "pg_nope" }, toolCtx);
    expect(missing.ok).toBe(false);
    expect(missing.content).toContain("inspect_external_page");
  });
});

describe("query_page_html", () => {
  it("keywordWindows returns tag-snapped windows around each hit", () => {
    const html = "<div><p>alpha</p></div><section><span>beta beta</span></section>";
    const w = keywordWindows(html, "beta", 5, 20);
    expect(w.length).toBe(2);
    // Windows are snapped to tag boundaries — no bare mid-tag cut.
    expect(w[0]).toContain("beta");
    expect(w[0]?.startsWith("<")).toBe(true);
  });

  it("keyword mode reuses a pageRef (no re-fetch) and returns HTML windows", async () => {
    clearPageInspectionCacheForTests();
    const first = await inspectExternalPageTool.handler(
      emptyCtx,
      { url: `${base}/`, facets: { markdown: true } },
      toolCtx,
    );
    const pageRef = /Page handle: (pg_\w+)/.exec(first.content ?? "")?.[1];
    expect(pageRef).toBeDefined();
    const r = await queryPageHtmlTool.handler(
      emptyCtx,
      { pageRef: pageRef!, keyword: "Öffnungszeiten" },
      toolCtx,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("Öffnungszeiten");
    expect(r.content).toContain("match");
  });

  it("requires exactly one mode (keyword XOR describe)", async () => {
    const none = await queryPageHtmlTool.handler(emptyCtx, { url: `${base}/` }, toolCtx);
    expect(none.ok).toBe(false);
    expect(none.content).toContain("EXACTLY ONE");
    const both = await queryPageHtmlTool.handler(
      emptyCtx,
      { url: `${base}/`, keyword: "x", describe: "y" },
      toolCtx,
    );
    expect(both.ok).toBe(false);
  });

  it("an evicted pageRef with no url fails cleanly", async () => {
    const r = await queryPageHtmlTool.handler(
      emptyCtx,
      { pageRef: "pg_gone", keyword: "x" },
      toolCtx,
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("re-run inspect_external_page");
  });

  it("css/xpath mode runs a selector via the shared screenshotter (setContent)", async () => {
    let queriedWith: unknown;
    setExternalScreenshotterForTests(async () => ({
      capture: async () => ({ bytes: new Uint8Array([1]), width: 1280, height: 800 }),
      query: async (_html, opts) => {
        queriedWith = opts;
        return ['<a href="/en/pricing">Preise</a>'];
      },
      dispose: async () => undefined,
    }));
    clearPageInspectionCacheForTests();
    const first = await inspectExternalPageTool.handler(
      emptyCtx,
      { url: `${base}/`, facets: { markdown: true } },
      toolCtx,
    );
    const pageRef = /Page handle: (pg_\w+)/.exec(first.content ?? "")?.[1];
    const r = await queryPageHtmlTool.handler(
      emptyCtx,
      { pageRef: pageRef!, cssSelector: "nav a" },
      toolCtx,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('<a href="/en/pricing">Preise</a>');
    expect(r.content).toContain("nav a");
    expect(queriedWith).toMatchObject({ cssSelector: "nav a" });
  });

  it("query prefers the RENDERED DOM when a screenshot render populated the pageRef", async () => {
    // The render returns HTML carrying a marker that is NOT in the static
    // fetched fixture — proving query_page_html uses renderedHtml.
    setExternalScreenshotterForTests(async () => ({
      capture: async () => ({
        bytes: new Uint8Array([1]),
        width: 1280,
        height: 800,
        renderedHtml: "<html><body><div id='jsonly'>RENDERED-ONLY-MARKER</div></body></html>",
      }),
      query: async () => [],
      dispose: async () => undefined,
    }));
    clearPageInspectionCacheForTests();
    const first = await inspectExternalPageTool.handler(
      emptyCtx,
      { url: `${base}/`, facets: { screenshot: true, markdown: true } },
      toolCtx,
    );
    const pageRef = /Page handle: (pg_\w+)/.exec(first.content ?? "")?.[1];
    expect(pageRef).toBeDefined();
    const r = await queryPageHtmlTool.handler(
      emptyCtx,
      { pageRef: pageRef!, keyword: "RENDERED-ONLY-MARKER" },
      toolCtx,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("RENDERED-ONLY-MARKER");
  });

  it("links facet is opt-in: {links:true} pulls the inventory", async () => {
    const r = await inspectExternalPageTool.handler(
      emptyCtx,
      { url: `${base}/`, facets: { links: true } },
      toolCtx,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("## Outbound links");
    expect(r.content).toContain("Preise");
    // Fragment links dropped; cross-host links KEPT (the links facet is
    // general — the page-type classifier is what filters off-site).
    expect(r.content).not.toContain("#top");
    expect(r.content).toContain("https://instagram.com/x");
  });

  it("meta facet exposes canonical, lang, hreflang, and the h1–h3 outline", async () => {
    const r = await inspectExternalPageTool.handler(
      emptyCtx,
      { url: `${base}/`, facets: { meta: true } },
      toolCtx,
    );
    expect(r.content).toContain("Lang: en");
    expect(r.content).toContain(`Canonical: ${base}/en/`);
    expect(r.content).toContain(`de → ${base}/de/`);
    expect(r.content).toContain("h2: Unser Brot");
    // meta-only: no links section.
    expect(r.content).not.toContain("## Outbound links");
  });

  it("links facet groups by nav/footer/body and resolves relative→absolute", async () => {
    const r = await inspectExternalPageTool.handler(
      emptyCtx,
      { url: `${base}/`, facets: { links: true } },
      toolCtx,
    );
    expect(r.content).toContain("### Nav links");
    expect(r.content).toContain("### Footer links");
    expect(r.content).toContain(`${base}/en/pricing`);
    expect(r.content).toContain(`"Impressum" → ${base}/en/impressum`);
  });

  it("altTexts facet inventories img alt + aria-label", async () => {
    const r = await inspectExternalPageTool.handler(
      emptyCtx,
      { url: `${base}/`, facets: { altTexts: true } },
      toolCtx,
    );
    expect(r.content).toContain('img alt="Frisches Sauerteigbrot"');
    expect(r.content).toContain('aria-label="Menü öffnen"');
  });

  it("markup facet returns cleaned extractor modules", async () => {
    const r = await inspectExternalPageTool.handler(
      emptyCtx,
      { url: `${base}/`, facets: { markup: true } },
      toolCtx,
    );
    expect(r.content).toContain("## Markup (extracted modules)");
    expect(r.content).toContain("[header]");
    expect(r.content).toContain("[footer]");
  });

  it("screenshot facet attaches a rendered image via the shared screenshotter", async () => {
    const fakeShot: Screenshot = {
      bytes: new Uint8Array([137, 80, 78, 71]),
      width: 1280,
      height: 800,
    };
    let capturedOpts: unknown;
    setExternalScreenshotterForTests(async () => ({
      capture: async (_url, opts) => {
        capturedOpts = opts;
        return fakeShot;
      },
      query: async () => [],
      dispose: async () => undefined,
    }));
    const r = await inspectExternalPageTool.handler(
      emptyCtx,
      { url: `${base}/`, facets: { screenshot: true } },
      toolCtx,
    );
    expect(r.ok).toBe(true);
    expect(r.image?.mediaType).toBe("image/png");
    expect(r.image?.base64).toBe(Buffer.from(fakeShot.bytes).toString("base64"));
    expect(capturedOpts).toMatchObject({ external: true, fullPage: false });
  });

  it("tokens facet: static fact base always, computed-style tokens from one render pass", async () => {
    setExternalScreenshotterForTests(async () => ({
      capture: async (_url, opts) => ({
        bytes: new Uint8Array([1]),
        width: 1280,
        height: 800,
        ...(opts?.sampleStyles
          ? { styleSamples: [{ role: "body" as const, styles: { color: "rgb(28, 25, 23)" } }] }
          : {}),
      }),
      query: async () => [],
      dispose: async () => undefined,
    }));
    const r = await inspectExternalPageTool.handler(
      emptyCtx,
      { url: `${base}/`, facets: { tokens: true } },
      toolCtx,
    );
    expect(r.content).toContain("## Design fact base (static, CSS-derived)");
    // static inventory sees the linked stylesheet's palette.
    expect(r.content.toLowerCase()).toContain("#fef3c7");
    // computed-style tokens derived from the render pass.
    expect(r.content).toContain("## Computed-style design tokens (rendered)");
    expect(r.content).toContain("#1c1917");
  });

  it("tokens facet fails LOUDLY (no silent degrade) when Playwright is missing, static base still shown", async () => {
    setExternalScreenshotterForTests(async () => null);
    const r = await inspectExternalPageTool.handler(
      emptyCtx,
      { url: `${base}/`, facets: { screenshot: true, tokens: true } },
      toolCtx,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("UNAVAILABLE");
    expect(r.content).toContain("Do NOT claim you saw the page");
    expect(r.image).toBeUndefined();
    // Static fact base does not need a browser — still present.
    expect(r.content).toContain("## Design fact base (static, CSS-derived)");
  });

  it("refuses private URLs via the real SSRF guard", async () => {
    const r = await inspectExternalPageTool.handler(
      emptyCtx,
      { url: "http://169.254.169.254/latest/meta-data/" },
      toolCtx,
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("External URL blocked");
  });

  it("exhausts the per-session budget with an actionable message", async () => {
    let last: Awaited<ReturnType<typeof inspectExternalPageTool.handler>> | null = null;
    for (let i = 0; i < 13; i++) {
      last = await inspectExternalPageTool.handler(emptyCtx, { url: `${base}/` }, toolCtx);
    }
    expect(last?.ok).toBe(false);
    expect(last?.content).toContain("propose_site_import");
  });
});

describe("map_external_page_types", () => {
  it("maps the homepage nav/footer + sitemap sample into filtered page types", async () => {
    const r = await mapExternalPageTypesTool.handler(emptyCtx, { url: `${base}/en` }, toolCtx);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("# Page-type map");
    expect(r.content).toContain("Active locale: /en");
    // Real nav types named from their (German) anchor label + sample.
    expect(r.content).toContain('type="preise"');
    expect(r.content).toContain(`sample: ${base}/en/pricing`);
    expect(r.content).toContain('why: nav label "Preise"');
    // /blog/* collapse into ONE collection type sampling an article.
    expect(r.content).toContain('type="blog-article"');
    expect(r.content).toContain(`${base}/en/blog/post-1`);
    // Footer legal page.
    expect(r.content).toContain('type="impressum"');
    // Sitemap-only type.
    expect(r.content).toContain('type="tools"');
    // Noise filtered, never a type.
    expect(r.content).toContain("Filtered as noise");
    expect(r.content).not.toContain('type="tag"');
    expect(r.content).not.toContain('type="2023"');
    // /de/* is reported as filtered noise but never sampled as a type.
    expect(r.content).not.toContain(`sample: ${base}/de/`);
  });

  it("classifies nav/footer even with sitemap disabled", async () => {
    const r = await mapExternalPageTypesTool.handler(
      emptyCtx,
      { url: `${base}/en`, includeSitemap: false },
      toolCtx,
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain("sitemap not sampled");
    expect(r.content).toContain('type="preise"');
  });

  it("refuses private URLs via the real SSRF guard", async () => {
    const r = await mapExternalPageTypesTool.handler(
      emptyCtx,
      { url: "http://169.254.169.254/latest/meta-data/" },
      toolCtx,
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("External URL blocked");
  });
});

describe("screenshot_external_page (shared screenshotter seam)", () => {
  it("returns the capture as a multimodal image result", async () => {
    const fakeShot: Screenshot = { bytes: new Uint8Array([137, 80, 78, 71]), width: 4, height: 1 };
    let capturedOpts: unknown;
    setExternalScreenshotterForTests(async () => ({
      capture: async (_url, opts) => {
        capturedOpts = opts;
        return fakeShot;
      },
      query: async () => [],
      dispose: async () => undefined,
    }));
    const r = await screenshotExternalPageTool.handler(
      emptyCtx,
      { url: "https://example.com/" },
      toolCtx,
    );
    expect(r.ok).toBe(true);
    expect(r.image?.mediaType).toBe("image/png");
    expect(r.image?.base64).toBe(Buffer.from(fakeShot.bytes).toString("base64"));
    expect(capturedOpts).toMatchObject({ external: true, fullPage: false });
  });

  it("fails LOUDLY when Playwright is unavailable — no silent degrade", async () => {
    setExternalScreenshotterForTests(async () => null);
    const r = await screenshotExternalPageTool.handler(
      emptyCtx,
      { url: "https://example.com/" },
      toolCtx,
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("UNAVAILABLE");
    expect(r.content).toContain("Do NOT claim you saw the page");
    expect(r.image).toBeUndefined();
  });
});

describe("pure extractors", () => {
  it("extractStylesheetHrefs: same-host only, capped", () => {
    const html = `<link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="https://cdn.example/b.css"><link rel="icon" href="/fav.ico">`;
    const hrefs = extractStylesheetHrefs(html, "https://site.example/");
    expect(hrefs).toEqual(["https://site.example/a.css"]);
  });
});
