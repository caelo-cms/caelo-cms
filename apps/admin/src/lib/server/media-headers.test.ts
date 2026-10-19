// SPDX-License-Identifier: MPL-2.0

/**
 * #863 (H-04) — media served from the admin origin. The CSP must reach every
 * SVG (the second line behind `sanitizeSvg`) and must NOT reach a PDF:
 * `sandbox` stops Chrome's built-in viewer from opening it.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mediaSecurityHeaders, SVG_DOCUMENT_CSP } from "./media-headers.js";

describe("mediaSecurityHeaders", () => {
  it("sandboxes SVG documents without script, network or plugins", () => {
    const h = mediaSecurityHeaders("image/svg+xml");
    expect(h["content-security-policy"]).toBe(SVG_DOCUMENT_CSP);
    expect(SVG_DOCUMENT_CSP).toContain("default-src 'none'");
    expect(SVG_DOCUMENT_CSP).toContain("sandbox");
    expect(SVG_DOCUMENT_CSP).not.toContain("script-src");
    expect(h["x-content-type-options"]).toBe("nosniff");
  });

  it("matches the SVG type regardless of case or parameters", () => {
    expect(mediaSecurityHeaders("Image/SVG+XML; charset=utf-8")["content-security-policy"]).toBe(
      SVG_DOCUMENT_CSP,
    );
  });

  it("keeps embedded rasters and inline styles rendering", () => {
    expect(SVG_DOCUMENT_CSP).toContain("img-src data:");
    expect(SVG_DOCUMENT_CSP).toContain("style-src 'unsafe-inline'");
  });

  it("leaves PDFs and rasters openable (nosniff only)", () => {
    for (const type of ["application/pdf", "image/png", "image/webp", "video/mp4"]) {
      expect(mediaSecurityHeaders(type)).toEqual({ "x-content-type-options": "nosniff" });
    }
  });

  it("is what both /_caelo/media routes serve (read as source: bun cannot resolve #lib)", () => {
    for (const route of ["[slug]/+server.ts", "[assetId]/[variant]/+server.ts"]) {
      const src = readFileSync(
        resolve(import.meta.dir, "../../routes/_caelo/media", route),
        "utf8",
      );
      expect(src).toContain("...mediaSecurityHeaders(contentType)");
    }
  });
});
