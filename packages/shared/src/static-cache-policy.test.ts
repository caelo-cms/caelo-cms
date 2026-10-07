// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { CONTENT_HASHED_PATH_PATTERN, isContentHashedPath } from "./static-cache-policy.js";

/** Build outputs whose URL changes whenever their bytes change. */
const HASHED_PATHS = [
  // Lighthouse report on gcp-firebase staging (v0.10.28).
  "/_assets/fonts/inter/29ede7bd4be32ab0.woff2",
  "/_assets/fonts/manrope/f3a06e9b32049b82.woff2",
  `/_assets/fonts/pinned/${"a".repeat(64)}.woff2`,
  `/_assets/fonts/pinned/${"0".repeat(64)}.ttf`,
  "/_caelo/plugin/consent-manager/runtime.0123456789ab.js",
  "/_caelo/plugin/consent-manager/banner.abcdef012345.css",
  "/_app/immutable/chunks/abc.js",
];

/** Build outputs served under a stable name — must stay short-lived. */
const STABLE_PATHS = [
  "/",
  "/index.html",
  "/about/",
  "/about/index.html",
  "/en/about",
  "/robots.txt",
  "/sitemap.xml",
  "/routing-manifest.json",
  "/cdn_manifest.json",
  "/_content-types.json",
  // Media addressed by slug: bytes can change behind the same URL.
  "/_assets/searchviu-logo.png",
  "/_assets/hero/w800.webp",
  "/_assets/0b1f6c2e-9d7a-4c1e-8f3a-2b6d9e0c1a4f/orig.jpg",
  "/_caelo/media/hero",
  // Pinned-font license file is id-named, not hashed.
  "/_assets/fonts/pinned/0b1f6c2e-9d7a-4c1e-8f3a-2b6d9e0c1a4f.license.txt",
  // Look-alikes that must not slip through.
  "/_assets/fonts/inter/not-a-hash.woff2",
  "/_assets/fonts/inter/29ede7bd4be32ab0.woff2.html",
  "/_caelo/plugin/consent-manager/runtime.js",
  "/blog/_assets/fonts/inter/29ede7bd4be32ab0.woff2",
  "/api/forms/submit",
];

describe("isContentHashedPath", () => {
  it("matches every content-hashed build output", () => {
    for (const p of HASHED_PATHS) expect(isContentHashedPath(p)).toBe(true);
  });

  it("rejects pages, manifests and slug-addressed media", () => {
    for (const p of STABLE_PATHS) expect(isContentHashedPath(p)).toBe(false);
  });

  it("accepts build-dir-relative keys (no leading slash) the same way", () => {
    expect(isContentHashedPath("_assets/fonts/inter/29ede7bd4be32ab0.woff2")).toBe(true);
    expect(isContentHashedPath("_assets/searchviu-logo.png")).toBe(false);
  });

  it("uses only RE2-compatible syntax (Firebase Hosting + Caddy match with RE2)", () => {
    // No lookaround, no backreferences, no named groups.
    expect(CONTENT_HASHED_PATH_PATTERN).not.toMatch(/\(\?[=!<]/);
    expect(CONTENT_HASHED_PATH_PATTERN).not.toMatch(/\\[1-9]/);
    expect(CONTENT_HASHED_PATH_PATTERN.startsWith("^/")).toBe(true);
    expect(CONTENT_HASHED_PATH_PATTERN.endsWith("$")).toBe(true);
  });
});
