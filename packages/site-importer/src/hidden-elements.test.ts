// SPDX-License-Identifier: MPL-2.0

/**
 * issue #415 — hidden-element removal pass. Visibility is layout
 * knowledge, so the pass only exists inside a real render: this suite
 * launches the repo's Playwright Chromium (present in the workspace tree
 * for the admin's e2e) against a local Bun.serve fixture. When Chromium is
 * not installed the suite skips LOUDLY via console.warn — same degrade
 * contract as `createPlaywrightScreenshotter` itself.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createPlaywrightScreenshotter, type Screenshotter } from "./screenshot.js";

const FIXTURE = `<!doctype html><html><head><style>
  .mobile-nav { display: none; }
  .invisible { visibility: hidden; }
  .off-ancestor { display: none; }
</style></head><body>
<nav class="desktop-nav"><a href="/a">Visible link</a></nav>
<nav class="mobile-nav"><a href="/a">MobileOnly clone</a></nav>
<div class="invisible">InvisibilityCloak</div>
<div class="off-ancestor"><p>ChildOfHiddenAncestor</p></div>
<span aria-hidden="true">DecorativeGlyph</span>
<header style="position:fixed;top:0">FixedButVisibleHeader</header>
<main><p>Real content stays</p></main>
</body></html>`;

let server: ReturnType<typeof Bun.serve>;
let base: string;
let screenshotter: Screenshotter | null = null;
const savedAllowed = process.env.CAELO_IMPORTER_ALLOWED_HOSTS;

beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(FIXTURE, { headers: { "content-type": "text/html" } }),
  });
  base = `http://127.0.0.1:${server.port}`;
  process.env.CAELO_IMPORTER_ALLOWED_HOSTS = "127.0.0.1";
  screenshotter = await createPlaywrightScreenshotter({ allowedHosts: ["127.0.0.1"] });
  if (screenshotter === null) {
    console.warn(
      "[hidden-elements.test] Playwright Chromium unavailable — SKIPPING the live hidden-element pass assertions. Install with `bun node_modules/playwright/cli.js install chromium`.",
    );
  }
});

afterAll(async () => {
  await screenshotter?.dispose();
  server.stop(true);
  if (savedAllowed === undefined) delete process.env.CAELO_IMPORTER_ALLOWED_HOSTS;
  else process.env.CAELO_IMPORTER_ALLOWED_HOSTS = savedAllowed;
});

describe("REMOVE_HIDDEN_ELEMENTS_SCRIPT (live render)", () => {
  it("removes hidden subtrees from visibleHtml, keeps the full DOM in html", async () => {
    if (screenshotter === null) return; // loud skip in beforeAll
    const r = await screenshotter.renderHtml(`${base}/`, { external: true, stripHidden: true });
    // Full DOM untouched — query_page_html relies on it.
    expect(r.html).toContain("MobileOnly clone");
    expect(r.html).toContain("InvisibilityCloak");
    // Visible DOM: display:none, visibility:hidden, hidden-ancestor and
    // aria-hidden subtrees are gone…
    expect(r.visibleHtml).toBeDefined();
    expect(r.visibleHtml).not.toContain("MobileOnly clone");
    expect(r.visibleHtml).not.toContain("InvisibilityCloak");
    expect(r.visibleHtml).not.toContain("ChildOfHiddenAncestor");
    expect(r.visibleHtml).not.toContain("DecorativeGlyph");
    // …while visible content and position:fixed chrome (offsetParent===null
    // but VISIBLE — the guard this pass must not overreach past) survive.
    expect(r.visibleHtml).toContain("Real content stays");
    expect(r.visibleHtml).toContain("Visible link");
    expect(r.visibleHtml).toContain("FixedButVisibleHeader");
    // Each hidden SUBTREE counts once: mobile-nav, .invisible, .off-ancestor
    // (its child is not double-counted), aria-hidden span.
    expect(r.hiddenRemoved).toBe(4);
  });

  it("does not run the pass (and returns no visibleHtml) without stripHidden", async () => {
    if (screenshotter === null) return; // loud skip in beforeAll
    const r = await screenshotter.renderHtml(`${base}/`, { external: true });
    expect(r.visibleHtml).toBeUndefined();
    expect(r.hiddenRemoved).toBeUndefined();
    expect(r.html).toContain("MobileOnly clone");
  });
});
