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
} from "./media.js";

describe("media URL helpers", () => {
  it("builds canonical /_caelo/media URL with assetId + variant", () => {
    expect(buildMediaUrl("11111111-1111-1111-1111-111111111111", "webp-800")).toBe(
      "/_caelo/media/11111111-1111-1111-1111-111111111111/webp-800",
    );
  });

  it("extracts every (assetId, variant) reference deduped", () => {
    const html = `
      <img src="/_caelo/media/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/webp-800" alt="x" />
      <img src="/_caelo/media/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/webp-800" alt="y" />
      <img src="/_caelo/media/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/orig" />
    `;
    const refs = extractMediaRefs(html);
    expect(refs).toEqual([
      { assetId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", variant: "webp-800" },
      { assetId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", variant: "orig" },
    ]);
  });

  it("ignores ill-formed asset ids; accepts kebab-case variants (crops post-P7-opt-2)", () => {
    // Short id can never match (uuid pattern in the regex). A kebab-
    // case variant matches — this widened post-P7 to accept focal-
    // point crop variants like `square-800`. Unknown variants reach
    // the renderer / static-generator media-pass which fails loudly
    // when there's no media_variants row, per the no-fallbacks rule.
    const html = `
      <img src="/_caelo/media/short-id/webp-800" />
      <img src="/_caelo/media/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/square-800" />
    `;
    expect(extractMediaRefs(html)).toEqual([
      { assetId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", variant: "square-800" },
    ]);
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
