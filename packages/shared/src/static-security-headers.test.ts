// SPDX-License-Identifier: MPL-2.0

/**
 * #863 / #891 — the media security headers. The CSP must reach every SVG
 * (the second line behind `sanitizeSvg`) and must NOT reach a PDF:
 * `sandbox` stops Chrome's built-in viewer from opening it.
 */

import { describe, expect, it } from "bun:test";
import {
  isSvgContentType,
  mediaSecurityHeaders,
  SVG_DOCUMENT_CSP,
  SVG_PATH_PATTERN,
} from "./static-security-headers.js";

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
    expect(isSvgContentType(" image/svg+xml ")).toBe(true);
    expect(isSvgContentType("image/png")).toBe(false);
  });

  it("keeps embedded rasters and inline styles rendering", () => {
    expect(SVG_DOCUMENT_CSP).toContain("img-src data:");
    expect(SVG_DOCUMENT_CSP).toContain("style-src 'unsafe-inline'");
  });

  it("leaves PDFs and rasters openable (nosniff only)", () => {
    for (const type of ["application/pdf", "image/png", "image/webp", "video/mp4", "text/html"]) {
      expect(mediaSecurityHeaders(type)).toEqual({ "x-content-type-options": "nosniff" });
    }
  });
});

describe("SVG_PATH_PATTERN", () => {
  it("matches .svg paths in any case and nothing else", () => {
    for (const p of ["/_assets/logo.0123456789abcdef.svg", "/_assets/LOGO.SVG", "icon.Svg"]) {
      expect(new RegExp(SVG_PATH_PATTERN).test(p)).toBe(true);
    }
    for (const p of ["/_assets/logo.svgz", "/_assets/svg/logo.png", "/about/", "/x.svg/"]) {
      expect(new RegExp(SVG_PATH_PATTERN).test(p)).toBe(false);
    }
  });

  it("uses no inline flags or lookaround, so RE2 (Firebase Hosting) accepts it", () => {
    expect(SVG_PATH_PATTERN).not.toMatch(/\(\?/);
  });
});
