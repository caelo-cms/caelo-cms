// SPDX-License-Identifier: MPL-2.0

/**
 * issue #189 — single-page external sensing tools. Runs against a real
 * local Bun.serve fixture (no mocked HTTP) with the SSRF guard's
 * allowedHosts exemption scoped to the fixture host; blocked-URL cases
 * exercise the REAL guard.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Screenshot } from "@caelo-cms/site-importer";
import { resetExternalFetchBudgetForTests } from "../tools/_external-fetch-budget.js";
import type { ToolContext } from "../tools/dispatch.js";
import {
  extractContentOutline,
  extractStylesheetHrefs,
  inspectExternalPageTool,
} from "../tools/inspect-external-page.js";
import {
  screenshotExternalPageTool,
  setExternalScreenshotDepsForTests,
} from "../tools/screenshot-external-page.js";

const FIXTURE_HTML = `<!doctype html><html><head>
<title>Bergbäckerei Steinofen</title>
<meta name="description" content="Handgemachtes Sauerteigbrot aus Freiburg">
<link rel="stylesheet" href="/styles/main.css">
<style>.hero { background: linear-gradient(135deg, #7c2d12, #f59e0b); }</style>
</head><body>
<h1>Bergbäckerei Steinofen</h1>
<h2>Unser Brot</h2>
<h3>Öffnungszeiten</h3>
<nav><a href="/">Home</a><a href="/brot">Brot</a><a href="/kontakt">Kontakt</a>
<a href="https://instagram.com/x">IG</a><a href="#top">Top</a></nav>
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
      if (path === "/") {
        return new Response(FIXTURE_HTML, { headers: { "content-type": "text/html" } });
      }
      if (path === "/styles/main.css") {
        return new Response(FIXTURE_CSS, { headers: { "content-type": "text/css" } });
      }
      if (path === "/sitemap.xml") {
        return new Response(
          `<?xml version="1.0"?><urlset><url><loc>${base}/</loc></url><url><loc>${base}/brot</loc></url><url><loc>${base}/kontakt</loc></url></urlset>`,
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
  setExternalScreenshotDepsForTests(null);
});

const toolCtx = { chatSessionId: "11111111-1111-4111-8111-111111111111" } as ToolContext;
const emptyCtx = {
  actorId: "22222222-2222-4222-8222-222222222222",
  actorKind: "ai" as const,
  requestId: "test",
};

describe("inspect_external_page", () => {
  it("returns fact base + outline + sitemap count for a live fixture", async () => {
    const r = await inspectExternalPageTool.handler(emptyCtx, { url: `${base}/` }, toolCtx);
    expect(r.ok).toBe(true);
    // Content outline.
    expect(r.content).toContain("Bergbäckerei Steinofen");
    expect(r.content).toContain("Handgemachtes Sauerteigbrot");
    expect(r.content).toContain("h2: Unser Brot");
    // Same-host paths exclude cross-origin + fragment links.
    expect(r.content).toContain("/brot");
    expect(r.content).not.toContain("instagram");
    // Inventory sees inline AND linked-stylesheet colors.
    expect(r.content.toLowerCase()).toContain("#7c2d12");
    expect(r.content.toLowerCase()).toContain("#fef3c7");
    expect(r.content).toContain("linear-gradient");
    expect(r.content).toContain("Fraunces");
    // Sitemap probe.
    expect(r.content).toContain("sitemap.xml lists 3 URLs");
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

describe("screenshot_external_page", () => {
  it("returns the capture as a multimodal image result", async () => {
    const fakeShot: Screenshot = { bytes: new Uint8Array([137, 80, 78, 71]), width: 4, height: 1 };
    let capturedOpts: unknown;
    setExternalScreenshotDepsForTests(async () => ({
      capture: async (_url, opts) => {
        capturedOpts = opts;
        return fakeShot;
      },
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
    // The guard + glance contract: external capture, viewport-only.
    expect(capturedOpts).toMatchObject({ external: true, fullPage: false });
  });

  it("fails LOUDLY when Playwright is unavailable — no silent degrade", async () => {
    setExternalScreenshotDepsForTests(async () => null);
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

  it("extractContentOutline: title, meta, headings", () => {
    const o = extractContentOutline(FIXTURE_HTML);
    expect(o.title).toBe("Bergbäckerei Steinofen");
    expect(o.metaDescription).toContain("Sauerteigbrot");
    expect(o.headings[0]).toBe("h1: Bergbäckerei Steinofen");
  });
});
