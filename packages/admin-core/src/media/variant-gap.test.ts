// SPDX-License-Identifier: MPL-2.0

/**
 * run #10 D4 — skip-reason logic for missing media variants. Five
 * migrated assets lacked webp-800 (source narrower than 800px — the
 * pipeline never upscales) and the staging build hard-blocked with no
 * recovery path. These tests pin down WHEN a regenerate run is
 * expected to close a gap vs when the gap is by-design and the module
 * HTML must reference an existing variant instead.
 */

import { describe, expect, it } from "bun:test";
import { computeVariantGap } from "./variant-gap.js";

describe("computeVariantGap", () => {
  it("reports no gap for a complete wide raster", () => {
    const gap = computeVariantGap({
      mime: "image/jpeg",
      width: 2000,
      existingVariants: ["orig", "webp-400", "webp-800", "webp-1200", "webp-1600"],
    });
    expect(gap.missing).toEqual([]);
    expect(gap.skipReason).toBeNull();
  });

  it("flags satisfiable-but-absent breakpoints as regenerable (swallowed pipeline error)", () => {
    const gap = computeVariantGap({
      mime: "image/png",
      width: 1000,
      existingVariants: ["orig"],
    });
    expect(gap.missing).toEqual(["webp-800", "webp-400"]);
    expect(gap.skipReason).toBeNull();
  });

  it("run #10 case: 600px source with webp-400 present — webp-800 is NOT expected", () => {
    const gap = computeVariantGap({
      mime: "image/jpeg",
      width: 600,
      existingVariants: ["orig", "webp-400"],
    });
    expect(gap.missing).toEqual([]);
    expect(gap.skipReason).toBeNull();
  });

  it("explains tiny sources (below the 400px breakpoint) with an /orig pointer", () => {
    const gap = computeVariantGap({
      mime: "image/png",
      width: 180,
      existingVariants: ["orig"],
    });
    expect(gap.missing).toEqual([]);
    expect(gap.skipReason).toContain("180px");
    expect(gap.skipReason).toContain("/orig");
  });

  it("explains non-raster kinds (svg/pdf/video/fonts) with an /orig pointer", () => {
    for (const mime of ["image/svg+xml", "application/pdf", "video/mp4", "font/woff2"]) {
      const gap = computeVariantGap({ mime, width: null, existingVariants: ["orig"] });
      expect(gap.missing).toEqual([]);
      expect(gap.skipReason).toContain(mime);
      expect(gap.skipReason).toContain("/orig");
    }
  });

  it("treats a raster with unknown width as fully regenerable", () => {
    const gap = computeVariantGap({
      mime: "image/jpeg",
      width: null,
      existingVariants: ["orig"],
    });
    expect(gap.missing).toEqual(["webp-1600", "webp-1200", "webp-800", "webp-400"]);
    expect(gap.skipReason).toBeNull();
  });

  it("ignores crop fan-out variants when checking the ladder", () => {
    const gap = computeVariantGap({
      mime: "image/jpeg",
      width: 900,
      existingVariants: ["orig", "square-800", "webp-400", "webp-800"],
    });
    expect(gap.missing).toEqual([]);
    expect(gap.skipReason).toBeNull();
  });
});
