// SPDX-License-Identifier: MPL-2.0

/**
 * P14 polish — Playwright-driven screenshot capture for the importer.
 *
 * Used by the orchestrator's importerTick to take a "ground truth"
 * screenshot of each crawled URL, then a "rendered" screenshot of the
 * staged Caelo page, then feed both PNG buffers into a pixel-diff to
 * populate `import_pages.diff_status` + `diff_pct`.
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
import { assertPublicHttpUrl, isPublicIpAddress } from "./safe-fetch.js";
import {
  STRUCTURAL_DIFF_COLS,
  STRUCTURAL_DIFF_ROWS,
  type StructuralDiff,
  structuralDiffFraction,
} from "./screenshot-diff.js";

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
  /** issue #247 — raw computed-style samples collected in the SAME
   *  render session, present only when `sampleStyles: true` was
   *  requested. Feed into `deriveDesignTokens`. */
  readonly styleSamples?: readonly ElementStyleSample[];
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
    },
  ): Promise<Screenshot>;
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
  return {
    async capture(url, opts) {
      if (opts?.external) {
        // Static pre-check: scheme/port/IP-literal blocks fire before a
        // browser context is even opened.
        assertPublicHttpUrl(url, { allowedHosts });
      }
      const ctx = await browser.newContext({
        viewport: { width: opts?.width ?? 1280, height: opts?.height ?? 800 },
      });
      if (opts?.external) {
        // Guard every request the page makes (navigation + subresources).
        // Hostnames are resolved at route time; the browser resolves
        // again to connect, so a rebinding race is narrowed rather than
        // eliminated here — the primary target (direct navigation or an
        // <img>/fetch to a metadata/loopback address) is fully blocked.
        // The socket-level guarantee lives in safe-fetch.ts for HTML
        // fetching; screenshots are pixels-only exposure.
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
        // `domcontentloaded` is fast + reliable; then a SHORT best-effort
        // wait for the network to settle so late imagery is captured —
        // capped so we never pay the old 30s `networkidle` timeout, which
        // routinely fired because the SSRF route-guard aborts blocked
        // subresources and `networkidle` then never settles.
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
        await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
        const png = await page.screenshot({ fullPage: opts?.fullPage ?? true, type: "png" });
        // issue #247 — sample AFTER the screenshot so the pixels are
        // captured even if the evaluate throws mid-flight; the throw
        // still fails this capture attempt (loud, retried upstream).
        let styleSamples: ElementStyleSample[] | undefined;
        if (opts?.sampleStyles) {
          styleSamples = (await page.evaluate(
            COLLECT_STYLE_SAMPLES_SCRIPT,
          )) as ElementStyleSample[];
        }
        return {
          bytes: new Uint8Array(png),
          width: opts?.width ?? 1280,
          height: opts?.height ?? 800,
          ...(styleSamples ? { styleSamples } : {}),
        };
      } finally {
        await ctx.close();
      }
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

/**
 * Pure-byte pixel-diff. Returns the fraction of differing pixels in
 * [0, 1] over the size-matched intersection. For mismatched sizes the
 * fraction is computed over the smaller of the two; the size delta is
 * also penalised so wildly different layouts read as "fail".
 *
 * Note: this is a coarse RGB exact-match comparator, not a perceptual
 * diff. It catches "the imported page is mostly empty" / "the wrong
 * template applied"; it doesn't catch font-rendering differences. v1
 * ships this; a real perceptual-diff (e.g. pixelmatch) lands when
 * telemetry shows the false-positive rate is too high.
 */
export async function computePixelDiff(a: Screenshot, b: Screenshot): Promise<number> {
  // Decode both PNGs via Bun's image API. We only count differing
  // pixel bytes after a stride-aligned compare, which is good enough
  // to distinguish "completely different layouts" from "near-identical
  // renders".
  const aRgba = await decodePngToRgba(a.bytes);
  const bRgba = await decodePngToRgba(b.bytes);

  // Penalise size mismatches: if widths or heights differ by more than
  // 10%, treat as "fail" outright.
  const wRatio = Math.min(a.width, b.width) / Math.max(a.width, b.width);
  const hRatio = Math.min(a.height, b.height) / Math.max(a.height, b.height);
  if (wRatio < 0.9 || hRatio < 0.9) return 1;

  const len = Math.min(aRgba.length, bRgba.length);
  if (len === 0) return 1;
  let differing = 0;
  // Each pixel is 4 bytes (RGBA); count differing pixels not bytes so
  // the fraction is in pixel units.
  for (let i = 0; i < len; i += 4) {
    if (aRgba[i] !== bRgba[i] || aRgba[i + 1] !== bRgba[i + 1] || aRgba[i + 2] !== bRgba[i + 2]) {
      differing += 1;
    }
  }
  const totalPx = Math.floor(len / 4);
  return totalPx === 0 ? 1 : differing / totalPx;
}

/**
 * Lightweight PNG → RGBA decoder. Tries Bun's native sharp-equivalent
 * first; falls back to returning the raw PNG bytes (which makes diff
 * meaningless but doesn't crash). The orchestrator catches and
 * skips-with-NULL when this fails, so callers don't need to special-case.
 */
async function decodePngToRgba(png: Uint8Array): Promise<Uint8Array> {
  // sharp is in admin-core's deps for media optimization; reach for it
  // here too rather than adding a second image lib.
  try {
    // biome-ignore lint/suspicious/noExplicitAny: opt-in dynamic import
    const sharpMod: any = await import("sharp" as string);
    const sharp = sharpMod.default ?? sharpMod;
    const buf = await sharp(png).raw().ensureAlpha().toBuffer();
    return new Uint8Array(buf);
  } catch {
    return png;
  }
}

/**
 * issue #250 (WS4) — coarse structural diff between two PNG byte buffers.
 * Downscales both to a fixed `cols*rows` RGB grid (flattening any alpha over
 * white so a transparent rebuild vs an opaque source doesn't read as a full
 * diff), then delegates to the pure `structuralDiffFraction`. Aspect-ratio
 * differences are intentionally normalized away by the resize: two "full
 * homepage" screenshots of different heights still compare band-for-band,
 * which is exactly the structure the fidelity gate measures.
 *
 * Unlike `computePixelDiff`, sharp is REQUIRED here (not optional): a decode
 * failure throws so the caller reports the page UNVERIFIED rather than
 * fake-passing on undecoded bytes (CLAUDE.md §2). sharp already ships in the
 * admin app's dependency tree (media optimization), which is the only
 * runtime that computes import fidelity.
 */
export async function computeStructuralDiff(
  sourcePng: Uint8Array,
  rebuiltPng: Uint8Array,
  opts?: { cols?: number; rows?: number },
): Promise<StructuralDiff> {
  const cols = opts?.cols ?? STRUCTURAL_DIFF_COLS;
  const rows = opts?.rows ?? STRUCTURAL_DIFF_ROWS;
  const [gridA, gridB] = await Promise.all([
    downscaleToRgbGrid(sourcePng, cols, rows),
    downscaleToRgbGrid(rebuiltPng, cols, rows),
  ]);
  return structuralDiffFraction(gridA, gridB, cols, rows);
}

/**
 * Resize a PNG to an exact `cols*rows` grid of flattened RGB bytes. `fit:
 * "fill"` forces the target dimensions (aspect ratio normalized away by
 * design); `flatten` composites over white before `removeAlpha` so the
 * output is deterministic 3-byte RGB the pure differ expects.
 */
async function downscaleToRgbGrid(
  png: Uint8Array,
  cols: number,
  rows: number,
): Promise<Uint8Array> {
  // biome-ignore lint/suspicious/noExplicitAny: opt-in dynamic import
  const sharpMod: any = await import("sharp" as string);
  const sharp = sharpMod.default ?? sharpMod;
  const buf = await sharp(png)
    .resize(cols, rows, { fit: "fill" })
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer();
  return new Uint8Array(buf);
}
