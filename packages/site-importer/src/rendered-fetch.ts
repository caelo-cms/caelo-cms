// SPDX-License-Identifier: MPL-2.0

/**
 * The "rendered-first" HTML primitive. Every consumer that needs a page's
 * DOM — the AI inspection tools AND the crawler — routes through here so it
 * sees the JS-APPLIED DOM, not the pre-JS source. A page that sets an image
 * or video `src`, builds its nav, or injects sections with JavaScript is
 * invisible to a static fetch; the rendered DOM has it.
 *
 * `safeExternalFetch` is retained only as the FALLBACK (no Playwright, or a
 * render that failed) and for genuinely non-DOM resources (stylesheets,
 * sitemap XML, media binaries) which their callers fetch directly.
 *
 * No silent degrade (CLAUDE.md §2): when we fall back to static HTML, the
 * result carries a loud `note` the caller surfaces so the model knows the
 * content may be incomplete.
 */

import type { ElementStyleSample } from "./design-tokens.js";
import { isExternalUrlBlockedError, safeExternalFetch } from "./safe-fetch.js";
import type { Screenshotter } from "./screenshot.js";

export interface RenderedFetchOk {
  readonly ok: true;
  readonly finalUrl: string;
  readonly html: string;
  /** true = post-JS DOM from a browser render; false = static fallback. */
  readonly rendered: boolean;
  /** Computed-style samples, when `sampleStyles` was requested AND a render happened. */
  readonly styleSamples?: readonly ElementStyleSample[];
  /** Loud note when the static fallback was used (see file header). */
  readonly note?: string;
}

export interface RenderedFetchErr {
  readonly ok: false;
  /** SSRF guard rejected the URL. */
  readonly blocked?: boolean;
  /** HTTP status when the static fetch answered non-2xx. */
  readonly status?: number;
  /** Content-type when the URL wasn't HTML. */
  readonly contentType?: string;
  readonly message: string;
}

export type RenderedFetchResult = RenderedFetchOk | RenderedFetchErr;

const STATIC_FALLBACK_NOTE =
  "static-only (Chromium unavailable) — a page that sets src/content via JavaScript may be incomplete here; the fields below reflect the pre-JS source.";
const RENDER_FAILED_NOTE =
  "render failed; fell back to the static source — JS-applied content may be missing.";

/**
 * Fetch `url`'s DOM, rendered when possible. Tries a real browser render via
 * `screenshotter` first (JS runs), and falls back to a static
 * `safeExternalFetch` — with a loud note — when there's no screenshotter or
 * the render throws. The static path enforces the HTTP-status + content-type
 * + SSRF checks the render can't cheaply do.
 */
export async function fetchRenderedHtml(
  url: string,
  opts: {
    readonly screenshotter: Screenshotter | null;
    readonly allowedHosts: readonly string[];
    readonly maxBytes: number;
    /** Also collect computed-style samples during the render (design tokens). */
    readonly sampleStyles?: boolean;
  },
): Promise<RenderedFetchResult> {
  if (opts.screenshotter) {
    try {
      const r = await opts.screenshotter.renderHtml(url, {
        external: true,
        sampleStyles: opts.sampleStyles,
      });
      // Gate non-HTML even on the rendered path: a PDF/image navigates into a
      // browser viewer whose `page.content()` is not the resource. Only gate
      // when the response actually reported a type (undefined = trust it).
      if (r.contentType !== undefined && !r.contentType.includes("text/html")) {
        return {
          ok: false,
          contentType: r.contentType,
          message: `not an HTML page (${r.contentType})`,
        };
      }
      return {
        ok: true,
        finalUrl: r.finalUrl || url,
        html: r.html,
        rendered: true,
        ...(r.styleSamples ? { styleSamples: r.styleSamples } : {}),
      };
    } catch (e) {
      // A blocked URL is a hard stop — do NOT quietly retry it over the static
      // path (same SSRF policy would reject it there too, less clearly).
      if (isExternalUrlBlockedError(e)) return { ok: false, blocked: true, message: e.message };
      // Any other render failure (timeout, crash) degrades to static below.
    }
  }

  let res: Awaited<ReturnType<typeof safeExternalFetch>>;
  try {
    res = await safeExternalFetch(url, {
      allowedHosts: opts.allowedHosts,
      maxBytes: opts.maxBytes,
    });
  } catch (e) {
    if (isExternalUrlBlockedError(e)) return { ok: false, blocked: true, message: e.message };
    return {
      ok: false,
      message: `could not fetch ${url}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!res.ok) return { ok: false, status: res.status, message: `HTTP ${res.status}` };
  if (!res.contentType.includes("text/html")) {
    return {
      ok: false,
      contentType: res.contentType,
      message: `not an HTML page (${res.contentType || "unknown content type"})`,
    };
  }
  return {
    ok: true,
    finalUrl: res.finalUrl,
    html: res.bodyText,
    rendered: false,
    note: opts.screenshotter ? RENDER_FAILED_NOTE : STATIC_FALLBACK_NOTE,
  };
}
