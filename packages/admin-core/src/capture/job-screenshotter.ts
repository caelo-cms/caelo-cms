// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1217 — a `Screenshotter` whose renders run in the capture job, so
 * every caller of the shared screenshotter (screenshot_external_page,
 * inspect_external_page, query_page_html, map_external_page_types, the
 * site-import crawl and its ground-truth pass) works unchanged on a GCP
 * install while no Chromium runs in the admin.
 *
 * Only external renders go this way: the job has no route back into the
 * admin, so an own-origin capture (`external` unset) is refused here — the
 * branch preview has its own path (preview-capture.ts) that hands the job the
 * rendered document instead.
 */

import {
  EXTERNAL_URL_BLOCKED,
  type RenderedHtml,
  type Screenshot,
  type Screenshotter,
} from "@caelo-cms/site-importer";
import type { CaptureClient } from "./capture-client.js";
import type { CaptureResult } from "./capture-protocol.js";

/** A result of the wrong kind or an `error` result, as the error callers see. */
function unwrap<K extends CaptureResult["kind"]>(
  r: CaptureResult,
  kind: K,
): Extract<CaptureResult, { kind: K }> {
  if (r.kind === "error") {
    // The job's SSRF guard refused the URL: keep it recognisable
    // (`isExternalUrlBlockedError`), so callers stop instead of retrying the
    // same URL over a static fetch.
    throw r.code === EXTERNAL_URL_BLOCKED
      ? Object.assign(new Error(r.message), { code: EXTERNAL_URL_BLOCKED })
      : new Error(r.message);
  }
  if (r.kind !== kind) throw new Error(`the capture job answered a ${kind} with a ${r.kind}`);
  return r as Extract<CaptureResult, { kind: K }>;
}

/** Undefined-valued keys dropped, so the order passes the strict schema. */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/**
 * The job-backed screenshotter.
 *
 * @param allowedHosts - the SSRF guard's exemptions, passed with every order
 *   (the job applies the same guard the in-process browser does).
 */
export function jobScreenshotter(
  client: CaptureClient,
  allowedHosts: readonly string[],
): Screenshotter {
  const hosts = [...allowedHosts];
  return {
    async capture(url, opts) {
      if (!opts?.external || opts.sameOriginHeaders || opts.serve) {
        throw new Error(
          "the capture job renders external URLs only; a Caelo preview is captured through capturePreviewScreenshot",
        );
      }
      const r = unwrap(
        await client.run(() => ({
          kind: "external-capture",
          url,
          allowedHosts: hosts,
          opts: defined({
            width: opts.width,
            height: opts.height,
            fullPage: opts.fullPage,
            sampleStyles: opts.sampleStyles,
            captureHtml: opts.captureHtml,
            stripHidden: opts.stripHidden,
            selector: opts.selector,
          }),
        })),
        "capture",
      );
      return screenshotOf(r);
    },
    async renderHtml(url, opts) {
      if (!opts?.external) {
        throw new Error("the capture job renders external URLs only");
      }
      const r = unwrap(
        await client.run(() => ({
          kind: "external-render",
          url,
          allowedHosts: hosts,
          opts: defined({
            width: opts.width,
            height: opts.height,
            sampleStyles: opts.sampleStyles,
            stripHidden: opts.stripHidden,
          }),
        })),
        "render",
      );
      const out: RenderedHtml = {
        finalUrl: r.finalUrl,
        html: r.html,
        ...(r.contentType !== undefined ? { contentType: r.contentType } : {}),
        ...(r.styleSamples ? { styleSamples: r.styleSamples } : {}),
        ...(r.visibleHtml !== undefined ? { visibleHtml: r.visibleHtml } : {}),
        ...(r.hiddenRemoved !== undefined ? { hiddenRemoved: r.hiddenRemoved } : {}),
      };
      return out;
    },
    async query(html, opts) {
      if (!opts.cssSelector && !opts.xpath) return [];
      const r = unwrap(
        await client.run(
          (inputUrl) => {
            if (!inputUrl) throw new Error("a query needs its input");
            return defined({
              kind: "query" as const,
              inputUrl,
              cssSelector: opts.cssSelector,
              xpath: opts.cssSelector ? undefined : opts.xpath,
              maxMatches: opts.maxMatches,
            });
          },
          { text: JSON.stringify({ html }) },
        ),
        "query",
      );
      return r.matches;
    },
    async dispose() {
      // Nothing to close: every render is its own job execution.
    },
  };
}

/** A `capture` result as the Screenshot callers expect. Exported for tests. */
export function screenshotOf(r: Extract<CaptureResult, { kind: "capture" }>): Screenshot {
  return {
    bytes: new Uint8Array(Buffer.from(r.pngBase64, "base64")),
    width: r.width,
    height: r.height,
    ...(r.finalUrl !== undefined ? { finalUrl: r.finalUrl } : {}),
    ...(r.finalStatus !== undefined ? { finalStatus: r.finalStatus } : {}),
    ...(r.contentType !== undefined ? { contentType: r.contentType } : {}),
    ...(r.styleSamples ? { styleSamples: r.styleSamples } : {}),
    ...(r.renderedHtml !== undefined ? { renderedHtml: r.renderedHtml } : {}),
    ...(r.visibleHtml !== undefined ? { visibleHtml: r.visibleHtml } : {}),
    ...(r.hiddenRemoved !== undefined ? { hiddenRemoved: r.hiddenRemoved } : {}),
  };
}
