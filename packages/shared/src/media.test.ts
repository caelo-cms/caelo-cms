// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  buildMediaUrl,
  buildStorageKey,
  extractMediaRefs,
  MEDIA_ALLOWED_MIMES,
  MEDIA_HARD_LIMIT_BYTES,
  MEDIA_SIZE_CAPS,
  MEDIA_VARIANT_TAGS,
  MEDIA_VARIANT_WIDTHS,
  mediaListInputSchema,
  mediaSetCdnInputSchema,
  mediaUploadInputSchema,
  slugifyMediaName,
} from "./media.js";

describe("media URL helpers", () => {
  it("builds a slug URL: orig is flat, named variants nest under the slug", () => {
    expect(buildMediaUrl("searchviu-logo", "orig")).toBe("/_caelo/media/searchviu-logo");
    expect(buildMediaUrl("searchviu-hero", "webp-800")).toBe(
      "/_caelo/media/searchviu-hero/webp-800",
    );
  });

  it("extracts slug refs (orig implied when flat) deduped", () => {
    const html = `
      <img src="/_caelo/media/searchviu-hero/webp-800" alt="x" />
      <img src="/_caelo/media/searchviu-hero/webp-800" alt="y" />
      <img src="/_caelo/media/searchviu-logo" />
    `;
    expect(extractMediaRefs(html)).toEqual([
      { ref: "searchviu-hero", isSlug: true, variant: "webp-800" },
      { ref: "searchviu-logo", isSlug: true, variant: "orig" },
    ]);
  });

  it("still parses the legacy /_caelo/media/<uuid>/<variant> form as an id ref", () => {
    const html = `
      <img src="/_caelo/media/short-slug/webp-800" />
      <img src="/_caelo/media/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/square-800" />
    `;
    expect(extractMediaRefs(html)).toEqual([
      { ref: "short-slug", isSlug: true, variant: "webp-800" },
      { ref: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", isSlug: false, variant: "square-800" },
    ]);
  });

  it("slugifies a human label: accents stripped, kebab-cased, extension dropped", () => {
    expect(slugifyMediaName("SearchVIU Logo.png")).toBe("searchviu-logo");
    expect(slugifyMediaName("Über uns – Team!")).toBe("uber-uns-team");
    expect(slugifyMediaName("   ")).toBe("image");
    expect(slugifyMediaName("a".repeat(80)).length).toBeLessThanOrEqual(60);
  });

  it("buildStorageKey is sha-prefixed", () => {
    expect(buildStorageKey("abc123", "webp-800", "webp")).toBe("abc123/webp-800.webp");
  });
});

describe("media size caps + allowlist", () => {
  it("each allowed MIME has a positive size cap below the hard limit", () => {
    for (const m of MEDIA_ALLOWED_MIMES) {
      const cap = MEDIA_SIZE_CAPS[m];
      expect(cap).toBeGreaterThan(0);
      expect(cap).toBeLessThanOrEqual(MEDIA_HARD_LIMIT_BYTES);
    }
  });

  it("variant widths cover the non-orig tags only", () => {
    for (const t of MEDIA_VARIANT_TAGS) {
      if (t === "orig") continue;
      expect(MEDIA_VARIANT_WIDTHS[t]).toBeGreaterThan(0);
    }
  });
});

describe("media schemas", () => {
  it("mediaUploadInputSchema accepts a minimal valid payload", () => {
    const r = mediaUploadInputSchema.safeParse({
      sha256: "a".repeat(64),
      originalName: "hero.jpg",
      mime: "image/jpeg",
      sizeBytes: 1024,
      width: 1920,
      height: 1080,
      alt: "",
      storageKey: `${"a".repeat(64)}/orig.jpg`,
      variants: [
        {
          variant: "orig",
          format: "jpeg",
          width: 1920,
          height: 1080,
          sizeBytes: 1024,
          storageKey: `${"a".repeat(64)}/orig.jpg`,
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("mediaUploadInputSchema rejects non-hex sha256", () => {
    const r = mediaUploadInputSchema.safeParse({
      sha256: "not-a-sha",
      originalName: "x",
      mime: "image/jpeg",
      sizeBytes: 1,
      width: null,
      height: null,
      storageKey: "x",
      variants: [
        {
          variant: "orig",
          format: "jpeg",
          width: null,
          height: null,
          sizeBytes: 1,
          storageKey: "x",
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("mediaUploadInputSchema rejects unknown MIME", () => {
    const r = mediaUploadInputSchema.safeParse({
      sha256: "a".repeat(64),
      originalName: "x",
      mime: "application/zip",
      sizeBytes: 1,
      width: null,
      height: null,
      storageKey: "x",
      variants: [
        {
          variant: "orig",
          format: "jpeg",
          width: null,
          height: null,
          sizeBytes: 1,
          storageKey: "x",
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("mediaListInputSchema defaults sort=recent and limit=60", () => {
    const r = mediaListInputSchema.parse({});
    expect(r.sort).toBe("recent");
    expect(r.limit).toBe(60);
    expect(r.offset).toBe(0);
  });

  it("mediaSetCdnInputSchema rejects threshold below 1", () => {
    expect(mediaSetCdnInputSchema.safeParse({ enabled: true, threshold: 0 }).success).toBe(false);
  });
});
