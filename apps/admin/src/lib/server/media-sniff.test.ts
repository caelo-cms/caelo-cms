// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { sniffUploadMime } from "./media-sniff.js";

/**
 * ICONDIR + one 16x16 ICONDIRENTRY + a zeroed image body. `type` 1 is an
 * icon (.ico), 2 a cursor (.cur) — same container, same sniffed MIME.
 */
function iconContainer(type: 1 | 2): Uint8Array {
  const out = new Uint8Array(6 + 16 + 64);
  const v = new DataView(out.buffer);
  v.setUint16(2, type, true);
  v.setUint16(4, 1, true);
  out[6] = 16;
  out[7] = 16;
  v.setUint16(10, 1, true);
  v.setUint16(12, 32, true);
  v.setUint32(14, 64, true);
  v.setUint32(18, 22, true);
  return out;
}

describe("sniffUploadMime", () => {
  it("stores an .ico as the canonical image/x-icon whatever the browser declared", async () => {
    for (const declared of ["image/vnd.microsoft.icon", "image/x-icon", ""]) {
      expect(await sniffUploadMime(iconContainer(1), declared)).toEqual({
        mime: "image/x-icon",
        sniffedMime: "image/x-icon",
      });
    }
  });

  it("refuses a cursor (.cur) even though it sniffs as image/x-icon", async () => {
    expect((await sniffUploadMime(iconContainer(2), "image/x-icon")).mime).toBeNull();
  });

  it("keeps the SVG rule: declared svg + XML-looking body only", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect((await sniffUploadMime(svg, "image/svg+xml")).mime).toBe("image/svg+xml");
    expect((await sniffUploadMime(svg, "image/x-icon")).mime).toBeNull();
  });

  it("sniffs rasters from their bytes, not the declared type", async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    expect((await sniffUploadMime(png, "image/x-icon")).mime).toBe("image/png");
  });
});
