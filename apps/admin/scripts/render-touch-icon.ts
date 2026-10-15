// SPDX-License-Identifier: MPL-2.0

/**
 * Render `static/apple-touch-icon.png` (180x180) from the vector source
 * `static/apple-touch-icon.svg`.
 *
 * Why a PNG at all: iOS / iPadOS Safari ignores SVG `apple-touch-icon`
 * links and only honours raster images, so "Add to Home Screen" would
 * fall back to a page screenshot. The SVG stays the source of truth;
 * the PNG is the committed derivative. The source is the full-bleed
 * plate (no rounded corners, no inset): iOS applies its own squircle
 * mask, and transparent corners would render as black wedges.
 *
 * Usage (rerun whenever the SVG changes):
 *   bun run apps/admin/scripts/render-touch-icon.ts
 */

import { fileURLToPath } from "node:url";
import sharp from "sharp";

const TOUCH_ICON_PX = 180;

const source = fileURLToPath(new URL("../static/apple-touch-icon.svg", import.meta.url));
const target = fileURLToPath(new URL("../static/apple-touch-icon.png", import.meta.url));

// density scales the 32-unit viewBox well past 180 px before the resize,
// so librsvg rasterises the arcs at high resolution and the downscale
// anti-aliases them instead of upscaling a 32 px bitmap.
await sharp(source, { density: 72 * 8 })
  .resize(TOUCH_ICON_PX, TOUCH_ICON_PX)
  .png({ compressionLevel: 9 })
  .toFile(target);

console.log(`wrote ${target}`);
