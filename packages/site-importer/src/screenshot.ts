// SPDX-License-Identifier: MPL-2.0

/**
 * P14 polish — Playwright-driven screenshot capture for the importer.
 *
 * Used by the orchestrator's importerTick to take a "ground truth"
 * screenshot of each crawled URL and sample its computed styles in the
 * same render session, persisting the pixels + design tokens as the
 * live-inspect payload the theme proposal consumes.
 *
 * Playwright is intentionally NOT a hard dependency of @caelo-cms/site-importer
 * — it ships in the admin app's devDeps already (apps/admin/package.json)
 * and the orchestrator runs in the same process tree as the admin in
 * self-hosted Compose, so the binary is reachable. For Tier 2 / cloud
 * deployments where Playwright isn't bundled, the importerTick skips
 * screenshot capture and `diff_status` stays NULL — the gating policy
 * treats NULL as "not blocking", which preserves backward-compat with
 * the v1 ship that didn't take screenshots at all.
 *
 * Callers pass a screenshotter implementation; this file ships only the
 * abstraction + a thin Playwright-backed factory.
 */

import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { COLLECT_STYLE_SAMPLES_SCRIPT, type ElementStyleSample } from "./design-tokens.js";
import { REMOVE_HIDDEN_ELEMENTS_SCRIPT } from "./hidden-elements.js";
import { assertPublicHttpUrl, isPublicIpAddress } from "./safe-fetch.js";

/** Minimal Playwright route surface — typed locally so the package
 * doesn't need @types/playwright (Playwright stays a dynamic import). */
interface PlaywrightRoute {
  request(): { url(): string };
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}

export interface Screenshot {
  /** PNG bytes. */
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** The URL after redirects (`page.url()`), so callers report where they
   *  actually landed. */
  readonly finalUrl?: string;
  /** issue #247 — raw computed-style samples collected in the SAME
   *  render session, present only when `sampleStyles: true` was
   *  requested. Feed into `deriveDesignTokens`. */
  readonly styleSamples?: readonly ElementStyleSample[];
  /** The RENDERED HTML (`page.content()`, JS-applied DOM) captured in the
   *  same render session — present only when `captureHtml: true`. Lets the
   *  pageRef cache hold the rendered DOM so query_page_html's selectors run
   *  against it instead of the static fetched HTML. */
  readonly renderedHtml?: string;
  /** issue #415 — the rendered DOM AFTER the hidden-element pass removed
   *  invisible subtrees (mobile-nav clones, offscreen carousel slides,
   *  aria-hidden chrome). Present only when `stripHidden: true` was
   *  requested with `captureHtml`; `renderedHtml` above stays unstripped. */
  readonly visibleHtml?: string;
  /** Number of hidden subtrees the pass removed — callers MUST surface it
   *  (CLAUDE.md §2). Present exactly when `visibleHtml` is. */
  readonly hiddenRemoved?: number;
}

/**
 * Result of `renderHtml` — the JS-applied DOM of a page, without the pixel
 * cost of a screenshot. The "rendered-first" primitive uses this so every
 * content extractor (markdown, links, asset discovery, describe) sees what
 * the browser actually built, not the pre-JS source.
 */
export interface RenderedHtml {
  /** URL after redirects (`page.url()`). */
  readonly finalUrl: string;
  /** `page.content()` after `domcontentloaded` + a short network settle. */
  readonly html: string;
  /** `Content-Type` from the navigation response, so callers can gate
   *  non-HTML (a PDF/image renders in a viewer, not usable HTML). Undefined
   *  when the response exposed no headers. */
  readonly contentType?: string;
  /** Computed-style samples from the same render, when `sampleStyles: true`. */
  readonly styleSamples?: readonly ElementStyleSample[];
  /** issue #415 — the DOM AFTER the hidden-element pass, when
   *  `stripHidden: true`; `html` above stays the full unstripped DOM. */
  readonly visibleHtml?: string;
  /** Removed-subtree count of the hidden-element pass — present exactly
   *  when `visibleHtml` is; callers MUST surface it (CLAUDE.md §2). */
  readonly hiddenRemoved?: number;
}

export interface Screenshotter {
  /**
   * Capture a single full-page screenshot of `url` at the given viewport.
   * Caller is responsible for closing the underlying browser via
   * `dispose()` when done with all captures.
   *
   * issue #191 — pass `external: true` for third-party URLs: the page
   * then refuses navigations AND subresource loads that target
   * non-public addresses (the staged-preview captures of Caelo's own
   * localhost admin must NOT set it, which is why this is per-capture
   * rather than per-screenshotter).
   */
  capture(
    url: string,
    opts?: {
      width?: number;
      height?: number;
      external?: boolean;
      /** Default true (import-diff behaviour). issue #189's glance
       *  tools pass false: one viewport of pixels, not an archive. */
      fullPage?: boolean;
      /** issue #247 — also run the computed-style sampling script in
       *  the rendered page and return `styleSamples`. A sampling
       *  failure fails the capture (retry + loud note live at the
       *  caller): screenshot and tokens come from one render session,
       *  and a page that rendered will evaluate a style read. */
      sampleStyles?: boolean;
      /** Also return `page.content()` (the rendered JS-applied HTML) in the
       *  same render session, as `renderedHtml`. */
      captureHtml?: boolean;
      /** issue #415 — additionally run the hidden-element removal pass
       *  AFTER `renderedHtml` was read and return the visible-only DOM as
       *  `visibleHtml` (+ `hiddenRemoved`). Only meaningful together with
       *  `captureHtml`. */
      stripHidden?: boolean;
    },
  ): Promise<Screenshot>;
  /**
   * Render `url` (real `page.goto`, JS runs) and return its post-JS DOM
   * WITHOUT taking a screenshot — the cheap half of `capture` for the
   * "rendered-first" HTML primitive. SSRF-guarded like `capture` when
   * `external: true`.
   */
  renderHtml(
    url: string,
    opts?: {
      width?: number;
      height?: number;
      external?: boolean;
      sampleStyles?: boolean;
      /** issue #415 — also run the hidden-element removal pass after the
       *  full DOM was read; returns `visibleHtml` + `hiddenRemoved`. */
      stripHidden?: boolean;
    },
  ): Promise<RenderedHtml>;
  /**
   * Run a css/xpath selector against an HTML STRING (via `setContent` — no
   * navigation, no re-fetch) and return the matching elements' outerHTML,
   * capped by `maxMatches`. Powers `query_page_html`'s selector modes over
   * a cached page. All subresource requests are blocked (structure only).
   */
  query(
    html: string,
    opts: { cssSelector?: string; xpath?: string; maxMatches?: number },
  ): Promise<string[]>;
  dispose(): Promise<void>;
}

/**
 * Returns a Playwright-backed screenshotter, or null if Playwright isn't
 * importable in the current runtime. issue #247: a null return is NOT a
 * silent skip anymore — the orchestrator records a loud
 * `screenshot_missing` note on every affected import page so the run
 * report and downstream verification see those pages as UNVERIFIED.
 *
 * The dynamic import is wrapped in try/catch so a missing module (e.g.
 * a self-hosted install that didn't pre-install chromium) degrades to
 * "no screenshots, loudly noted" instead of crashing the orchestrator
 * tick.
 */
export async function createPlaywrightScreenshotter(guardOpts?: {
  /** issue #191 — hostnames exempt from the external-capture guard. */
  readonly allowedHosts?: readonly string[];
}): Promise<Screenshotter | null> {
  // Playwright is intentionally NOT a static dependency — see file
  // header. Dynamic + cast-to-unknown so the type-check doesn't need
  // @types/playwright in this package.
  // biome-ignore lint/suspicious/noExplicitAny: opt-in dynamic import
  let pw: any;
  try {
    // The specifier goes through a variable so bundlers CANNOT
    // statically follow it: rolldown/adapter-bun otherwise inlines
    // playwright → playwright-core → fsevents.node and the macOS
    // server build dies on the native binary ("stream did not
    // contain valid UTF-8"). The old `"playwright" as string` cast
    // only fooled TypeScript — it compiles to a static specifier.
    const specifier = "playwright";
    pw = await import(/* @vite-ignore */ specifier);
  } catch {
    return null;
  }
  // biome-ignore lint/suspicious/noExplicitAny: opaque browser handle
  let browser: any;
  try {
    browser = await pw.chromium.launch({ headless: true });
  } catch (e) {
    console.warn(
      "[site-importer] Playwright chromium launch failed — install the repo-pinned build with `bun node_modules/playwright/cli.js install chromium` (bunx may fetch a mismatched registry version). Skipping screenshot capture.",
      e,
    );
    return null;
  }
  const allowedHosts = guardOpts?.allowedHosts ?? [];

  /**
   * Open an SSRF-guarded context + page, navigate (domcontentloaded + a short
   * network settle), hand the page to `fn`, and always close the context.
   * `capture` and `renderHtml` share it so the route guard + goto policy live
   * in ONE place. `external:true` applies the per-request guard (issue #191).
   */
  async function withGuardedPage<T>(
    url: string,
    opts: { external?: boolean; width?: number; height?: number },
    // biome-ignore lint/suspicious/noExplicitAny: Playwright page + response handles (dynamic import, no @types)
    fn: (page: any, gotoResponse: any) => Promise<T>,
  ): Promise<T> {
    if (opts.external) {
      // Static pre-check: scheme/port/IP-literal blocks fire before a
      // browser context is even opened.
      assertPublicHttpUrl(url, { allowedHosts });
    }
    const ctx = await browser.newContext({
      viewport: { width: opts.width ?? 1280, height: opts.height ?? 800 },
    });
    if (opts.external) {
      // Guard every request the page makes (navigation + subresources).
      // Hostnames are resolved at route time; the browser resolves again to
      // connect, so a rebinding race is narrowed rather than eliminated — the
      // primary target (direct navigation or an <img>/fetch to a metadata/
      // loopback address) is fully blocked. The socket-level guarantee lives
      // in safe-fetch.ts.
      await ctx.route("**/*", async (route: PlaywrightRoute) => {
        const requestUrl = route.request().url();
        try {
          const u = assertPublicHttpUrl(requestUrl, { allowedHosts });
          const bareHost = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
          if (isIP(bareHost) === 0 && !allowedHosts.includes(bareHost.toLowerCase())) {
            const addresses = await new Promise<Array<{ address: string }>>((resolve, reject) => {
              dnsLookup(bareHost, { all: true }, (err, addrs) => {
                if (err) reject(err);
                else resolve(addrs as Array<{ address: string }>);
              });
            });
            if (addresses.some((a) => !isPublicIpAddress(a.address))) {
              await route.abort("blockedbyclient");
              return;
            }
          }
          await route.continue();
        } catch {
          await route.abort("blockedbyclient");
        }
      });
    }
    const page = await ctx.newPage();
    try {
      // `domcontentloaded` is fast + reliable; then a SHORT best-effort wait
      // for the network to settle so late imagery / JS-applied DOM is present
      // — capped so we never pay the old 30s `networkidle` timeout, which
      // routinely fired because the SSRF route-guard aborts blocked
      // subresources and `networkidle` then never settles.
      const gotoResponse = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
      return await fn(page, gotoResponse);
    } finally {
      await ctx.close();
    }
  }

  return {
    async capture(url, opts) {
      return withGuardedPage(
        url,
        { external: opts?.external, width: opts?.width, height: opts?.height },
        async (page) => {
          const png = await page.screenshot({ fullPage: opts?.fullPage ?? true, type: "png" });
          // issue #247 — sample AFTER the screenshot so the pixels are
          // captured even if the evaluate throws mid-flight; the throw still
          // fails this capture attempt (loud, retried upstream).
          let styleSamples: ElementStyleSample[] | undefined;
          if (opts?.sampleStyles) {
            styleSamples = (await page.evaluate(
              COLLECT_STYLE_SAMPLES_SCRIPT,
            )) as ElementStyleSample[];
          }
          // Rendered (JS-applied) HTML from the same session — so a later
          // query_page_html runs its selectors against the real DOM.
          const renderedHtml: string | undefined = opts?.captureHtml
            ? ((await page.content()) as string)
            : undefined;
          // issue #415 — the hidden-element pass runs IN the page (only the
          // browser knows layout/visibility) and MUTATES the DOM, so it goes
          // last: pixels, styles, and the full `renderedHtml` above are all
          // read first, keeping the unstripped DOM for query_page_html.
          let visibleHtml: string | undefined;
          let hiddenRemoved: number | undefined;
          if (opts?.captureHtml && opts?.stripHidden) {
            hiddenRemoved = (await page.evaluate(REMOVE_HIDDEN_ELEMENTS_SCRIPT)) as number;
            visibleHtml = (await page.content()) as string;
          }
          return {
            bytes: new Uint8Array(png),
            width: opts?.width ?? 1280,
            height: opts?.height ?? 800,
            finalUrl: page.url() as string,
            ...(styleSamples ? { styleSamples } : {}),
            ...(renderedHtml !== undefined ? { renderedHtml } : {}),
            ...(visibleHtml !== undefined ? { visibleHtml } : {}),
            ...(hiddenRemoved !== undefined ? { hiddenRemoved } : {}),
          };
        },
      );
    },
    async renderHtml(url, opts) {
      return withGuardedPage(
        url,
        { external: opts?.external, width: opts?.width, height: opts?.height },
        async (page, gotoResponse) => {
          let styleSamples: ElementStyleSample[] | undefined;
          if (opts?.sampleStyles) {
            styleSamples = (await page.evaluate(
              COLLECT_STYLE_SAMPLES_SCRIPT,
            )) as ElementStyleSample[];
          }
          const html = (await page.content()) as string;
          // issue #415 — hidden-element pass AFTER the full DOM read (it
          // mutates the page); see the matching block in `capture`.
          let visibleHtml: string | undefined;
          let hiddenRemoved: number | undefined;
          if (opts?.stripHidden) {
            hiddenRemoved = (await page.evaluate(REMOVE_HIDDEN_ELEMENTS_SCRIPT)) as number;
            visibleHtml = (await page.content()) as string;
          }
          // Content-type from the navigation response so callers can gate
          // non-HTML (a PDF/image renders in a viewer, not usable HTML).
          let contentType: string | undefined;
          try {
            const headers = (await gotoResponse?.headers?.()) as Record<string, string> | undefined;
            contentType = headers?.["content-type"];
          } catch {
            contentType = undefined;
          }
          return {
            finalUrl: page.url() as string,
            html,
            ...(contentType !== undefined ? { contentType } : {}),
            ...(styleSamples ? { styleSamples } : {}),
            ...(visibleHtml !== undefined ? { visibleHtml } : {}),
            ...(hiddenRemoved !== undefined ? { hiddenRemoved } : {}),
          };
        },
      );
    },
    async query(html, opts) {
      const ctx = await browser.newContext();
      try {
        // Structure only — block every subresource (SSRF + speed). The
        // document itself is set directly, so there is no navigation.
        await ctx.route("**/*", (route: PlaywrightRoute) => route.abort());
        const page = await ctx.newPage();
        await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 10_000 });
        const selector = opts.cssSelector
          ? opts.cssSelector
          : opts.xpath
            ? `xpath=${opts.xpath}`
            : null;
        if (selector === null) return [];
        const loc = page.locator(selector);
        const max = Math.min(await loc.count(), opts.maxMatches ?? 10);
        const out: string[] = [];
        for (let i = 0; i < max; i += 1) {
          // biome-ignore lint/suspicious/noExplicitAny: DOM element in the page context
          const h = (await loc.nth(i).evaluate((el: any) => el.outerHTML)) as string;
          out.push(h);
        }
        return out;
      } finally {
        await ctx.close();
      }
    },
    async dispose() {
      await browser.close();
    },
  };
}
