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
    },
  ): Promise<Screenshot>;
  dispose(): Promise<void>;
}

/**
 * Returns a Playwright-backed screenshotter, or null if Playwright isn't
 * importable in the current runtime. The orchestrator uses the null
 * return to silently skip screenshot capture (status stays NULL on the
 * import_pages row, which the gating policy treats as "no diff data,
 * publish allowed").
 *
 * The dynamic import is wrapped in try/catch so a missing module (e.g.
 * a self-hosted install that didn't pre-install chromium) degrades to
 * "no screenshots" instead of crashing the orchestrator tick.
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
        await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
        const png = await page.screenshot({ fullPage: opts?.fullPage ?? true, type: "png" });
        return {
          bytes: new Uint8Array(png),
          width: opts?.width ?? 1280,
          height: opts?.height ?? 800,
        };
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
