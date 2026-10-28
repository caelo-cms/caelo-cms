// SPDX-License-Identifier: MPL-2.0

/**
 * #1216 — tool screenshots are stored small: ≤1568 px long edge, WebP,
 * ≤300 KB, and the same input always encodes to the same bytes (the
 * content-addressed key, and with it the replayed history, must stay
 * byte-identical across turns for the prompt cache).
 */

import { describe, expect, it } from "bun:test";
import sharp from "sharp";
import { shrinkToolImage, TOOL_IMAGE_MAX_BYTES, TOOL_IMAGE_MAX_EDGE } from "./tool-image.js";

/** A page-like full-page capture: bands, cards and rules over 1440×6000. */
async function fullPageScreenshotPng(): Promise<Buffer> {
  const rows: string[] = [];
  for (let y = 0; y < 6000; y += 120) {
    const hue = (y / 6000) * 360;
    rows.push(`<rect x="0" y="${y}" width="1440" height="120" fill="hsl(${hue},40%,92%)"/>`);
    for (let x = 80; x < 1360; x += 320) {
      rows.push(
        `<rect x="${x}" y="${y + 16}" width="280" height="88" rx="8" fill="hsl(${(hue + x) % 360},55%,55%)"/>`,
      );
      for (let l = 0; l < 4; l++) {
        rows.push(
          `<rect x="${x + 12}" y="${y + 28 + l * 16}" width="${180 + ((x + l * 37) % 80)}" height="6" fill="#fff"/>`,
        );
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="6000">${rows.join("")}</svg>`;
  return await sharp(Buffer.from(svg)).png().toBuffer();
}

async function noisePng(width: number, height: number): Promise<Buffer> {
  return await sharp({
    create: { width, height, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 60 } },
  })
    .png()
    .toBuffer();
}

describe("shrinkToolImage", () => {
  it("brings a full-page PNG under the edge and byte caps as WebP", async () => {
    const png = await fullPageScreenshotPng();
    const out = await shrinkToolImage({ base64: png.toString("base64"), mediaType: "image/png" });
    const bytes = Buffer.from(out.base64, "base64");
    expect(out.mediaType).toBe("image/webp");
    expect(bytes.byteLength).toBeLessThanOrEqual(TOOL_IMAGE_MAX_BYTES);
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(TOOL_IMAGE_MAX_EDGE);
    // Aspect ratio kept: a 1440×6000 page shrinks to 1568 tall, ~376 wide.
    expect(meta.height).toBe(TOOL_IMAGE_MAX_EDGE);
    expect(meta.width).toBe(376);
  });

  it("encodes the same input to the same bytes (prompt-cache stability)", async () => {
    const png = await fullPageScreenshotPng();
    const input = { base64: png.toString("base64"), mediaType: "image/png" };
    const a = await shrinkToolImage(input);
    const b = await shrinkToolImage(input);
    expect(a.base64).toBe(b.base64);
  });

  it("never enlarges a small capture", async () => {
    const small = await sharp({
      create: { width: 390, height: 844, channels: 3, background: "#3366cc" },
    })
      .png()
      .toBuffer();
    const out = await shrinkToolImage({ base64: small.toString("base64"), mediaType: "image/png" });
    const meta = await sharp(Buffer.from(out.base64, "base64")).metadata();
    expect([meta.width, meta.height]).toEqual([390, 844]);
  });

  it("steps quality and size down until a busy capture fits", async () => {
    const png = await noisePng(1440, 900);
    const out = await shrinkToolImage({ base64: png.toString("base64"), mediaType: "image/png" });
    const bytes = Buffer.from(out.base64, "base64");
    expect(bytes.byteLength).toBeLessThanOrEqual(TOOL_IMAGE_MAX_BYTES);
    expect(bytes.byteLength).toBeLessThan(png.byteLength);
  });

  it("throws on bytes that are not an image", async () => {
    await expect(
      shrinkToolImage({
        base64: Buffer.from("not an image").toString("base64"),
        mediaType: "image/png",
      }),
    ).rejects.toThrow();
  });
});
