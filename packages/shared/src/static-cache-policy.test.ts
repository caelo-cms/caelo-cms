// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  CONTENT_HASHED_PATH_PATTERN,
  isContentHashedPath,
  isPinnedFontSliceFile,
} from "./static-cache-policy.js";

/** Build outputs whose URL changes whenever their bytes change. */
const HASHED_PATHS = [
  // Lighthouse report on gcp-firebase staging (v0.10.28).
  "/_assets/fonts/inter/29ede7bd4be32ab0.woff2",
  "/_assets/fonts/manrope/f3a06e9b32049b82.woff2",
  // #793 — `<source sha256>.<axis-spec hash>.<slice>.<toolchain tag>.woff2`.
  `/_assets/fonts/pinned/${"a".repeat(64)}.de5786ef1b56.latin.0123456789ab.woff2`,
  `/_assets/fonts/pinned/${"0".repeat(64)}.1f23e5fa3b6d.cyrillic-ext.0123456789ab.woff2`,
  "/_caelo/plugin/consent-manager/runtime.0123456789ab.js",
  "/_caelo/plugin/consent-manager/banner.abcdef012345.css",
  "/_app/immutable/chunks/abc.js",
  // #667 — published media, named by the hash of its bytes.
  "/_assets/searchviu-logo.0123456789abcdef.png",
  "/_assets/hero/webp-800.0123456789abcdef.webp",
  "/_assets/0b1f6c2e-9d7a-4c1e-8f3a-2b6d9e0c1a4f/orig.fedcba9876543210.jpg",
  "/_assets/brand-font.0123456789abcdef.woff2",
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
  // Pre-#667 media addressed by bare slug: bytes can change behind the same URL.
  "/_assets/searchviu-logo.png",
  "/_assets/hero/w800.webp",
  "/_assets/0b1f6c2e-9d7a-4c1e-8f3a-2b6d9e0c1a4f/orig.jpg",
  "/_caelo/media/hero",
  // Pinned-font license file is id-named, not hashed.
  "/_assets/fonts/pinned/0b1f6c2e-9d7a-4c1e-8f3a-2b6d9e0c1a4f.license.txt",
  // Look-alikes that must not slip through.
  // The registry source itself is never published; were a raw pinned file to
  // appear, it must not be pinned in caches for a year.
  `/_assets/fonts/pinned/${"0".repeat(64)}.ttf`,
  `/_assets/fonts/pinned/${"a".repeat(64)}.latin.woff2`,
  // Pre-#793 slice name (no axis-spec hash) — no longer emitted.
  `/_assets/fonts/pinned/${"a".repeat(64)}.latin.0123456789ab.woff2`,
  "/_assets/fonts/inter/not-a-hash.woff2",
  "/_assets/fonts/inter/29ede7bd4be32ab0.woff2.html",
  "/_caelo/plugin/consent-manager/runtime.js",
  "/blog/_assets/fonts/inter/29ede7bd4be32ab0.woff2",
  "/api/forms/submit",
  "/_assets/searchviu-logo.0123456789ABCDEF.png",
  "/_assets/searchviu-logo.0123456789abcde.png",
  "/_assets/a/b/c.0123456789abcdef.png",
  "/blog/_assets/searchviu-logo.0123456789abcdef.png",
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

describe("isPinnedFontSliceFile", () => {
  it("accepts the slice name the delivery emits (e2e-livedit run 38915969785)", () => {
    expect(
      isPinnedFontSliceFile(
        "29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031.de5786ef1b56.latin.3075c73f4eb5.woff2",
      ),
    ).toBe(true);
    expect(
      isPinnedFontSliceFile(`${"b".repeat(64)}.0123456789ab.latin-ext.0123456789ab.woff2`),
    ).toBe(true);
  });

  it("rejects the pre-#793 shape, other extensions and path segments", () => {
    expect(isPinnedFontSliceFile(`${"b".repeat(64)}.latin.0123456789ab.woff2`)).toBe(false);
    expect(isPinnedFontSliceFile(`${"b".repeat(64)}.0123456789ab.latin.0123456789ab.ttf`)).toBe(
      false,
    );
    expect(
      isPinnedFontSliceFile(`../${"b".repeat(64)}.0123456789ab.latin.0123456789ab.woff2`),
    ).toBe(false);
  });
});
