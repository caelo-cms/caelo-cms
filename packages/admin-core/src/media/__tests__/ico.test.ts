// SPDX-License-Identifier: MPL-2.0

/**
 * Favicon `.ico` support in the media library. ICO is stored under the
 * single canonical `image/x-icon` and, like SVG and webfonts, kept as-is:
 * only an `orig` variant, never handed to sharp.
 */

import { describe, expect, it } from "bun:test";
import { minimalIco } from "../../__tests__/fixtures/ico.js";
import { magicBytesMatchMime, normalizeAssetMime } from "../import-asset-urls.js";
import { runMediaPipeline } from "../pipeline.js";
import { computeVariantGap } from "../variant-gap.js";

const SHA = "a".repeat(64);

describe("ICO media", () => {
  it("the pipeline stores an ICO byte-for-byte as the only (orig) variant", async () => {
    const ico = minimalIco();
    const out = await runMediaPipeline(SHA, "image/x-icon", ico);
    expect(out.width).toBeNull();
    expect(out.height).toBeNull();
    expect(out.variants).toHaveLength(1);
    const orig = out.variants[0];
    expect(orig?.variant).toBe("orig");
    expect(orig?.format).toBe("ico");
    expect(orig?.contentType).toBe("image/x-icon");
    expect(orig?.storageKey).toBe(`${SHA}/orig.ico`);
    expect(orig?.sizeBytes).toBe(ico.byteLength);
    expect(orig?.body).toEqual(ico);
  });

  it("regenerate never expects a ladder for an ICO", () => {
    const gap = computeVariantGap({
      mime: "image/x-icon",
      width: null,
      existingVariants: ["orig"],
    });
    expect(gap.missing).toEqual([]);
    expect(gap.skipReason).toContain("non-raster");
  });

  it("imports normalise every icon content-type to the canonical image/x-icon", () => {
    expect(normalizeAssetMime("image/x-icon")).toBe("image/x-icon");
    expect(normalizeAssetMime("image/vnd.microsoft.icon")).toBe("image/x-icon");
    expect(normalizeAssetMime("Image/VND.Microsoft.Icon; charset=binary")).toBe("image/x-icon");
    expect(normalizeAssetMime("image/ico")).toBe("image/x-icon");
  });

  it("checks the ICONDIR magic and rejects cursors and HTML bodies", () => {
    expect(magicBytesMatchMime("image/x-icon", minimalIco())).toBe(true);
    // Same container, type 2 = cursor (.cur) — not a favicon.
    expect(magicBytesMatchMime("image/x-icon", new Uint8Array([0, 0, 2, 0, 1, 0]))).toBe(false);
    expect(magicBytesMatchMime("image/x-icon", new TextEncoder().encode("<!doctype html>"))).toBe(
      false,
    );
  });
});
