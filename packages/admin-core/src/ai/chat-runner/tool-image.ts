// SPDX-License-Identifier: MPL-2.0

/**
 * #1216 — tool-produced images (screenshots) are shrunk ONCE, right after
 * the tool returns, before they are stored, streamed to the operator's
 * tool card or put into the model history.
 *
 * Why these numbers:
 *   - 1568 px long edge is what the provider scales an image down to anyway
 *     before the model sees it (Anthropic: ≤1568 px long edge, ~1.15 MP),
 *     so a larger capture only costs memory and bandwidth — the model sees
 *     the same pixels. A full-page PNG screenshot is 1–1.6 MB as base64 and
 *     rode along on every SDK step of a turn.
 *   - WebP at quality 80 keeps UI text crisp (it is a lossy codec tuned for
 *     photographic and synthetic content alike) at a fraction of PNG size;
 *     if a busy page still exceeds {@link TOOL_IMAGE_MAX_BYTES}, quality and
 *     then size step down until it fits.
 *
 * Deterministic: the same input bytes always produce the same output bytes
 * (fixed encoder settings), so a re-shot of an unchanged page lands on the
 * same content-addressed key and the replayed history stays byte-identical
 * — the prompt cache survives (see `buildChatImageKey`).
 */

import sharp from "sharp";

/** Longest edge, in pixels, a stored tool image may have. */
export const TOOL_IMAGE_MAX_EDGE = 1568;

/** Byte ceiling for one stored tool image (encoded, not base64). */
export const TOOL_IMAGE_MAX_BYTES = 300 * 1024;

const QUALITY_STEPS = [80, 70, 60, 50] as const;
/** Size steps (fraction of the max edge) once quality alone is not enough. */
const SCALE_STEPS = [1, 0.75, 0.5, 0.35] as const;

/** A tool image as the chat runner carries it. */
export interface ToolImage {
  base64: string;
  mediaType: string;
}

/**
 * Downscale + re-encode a tool image as WebP within the edge and byte
 * caps. Throws when the bytes are not a decodable image — the caller
 * decides how loudly to fail (a tool result without a usable image).
 */
export async function shrinkToolImage(image: ToolImage): Promise<ToolImage> {
  const input = Buffer.from(image.base64, "base64");
  const meta = await sharp(input).metadata();
  const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (longEdge === 0) throw new Error(`tool image (${image.mediaType}) has no dimensions`);
  const baseEdge = Math.min(longEdge, TOOL_IMAGE_MAX_EDGE);
  let smallest: Buffer | null = null;
  for (const scale of SCALE_STEPS) {
    const edge = Math.round(baseEdge * scale);
    for (const quality of QUALITY_STEPS) {
      const out = await sharp(input)
        .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
        .webp({ quality, effort: 4 })
        .toBuffer();
      if (out.byteLength <= TOOL_IMAGE_MAX_BYTES) {
        return { base64: out.toString("base64"), mediaType: "image/webp" };
      }
      if (smallest === null || out.byteLength < smallest.byteLength) smallest = out;
    }
  }
  // Only noise-like pixels miss the cap at a third of the edge and quality
  // 50; the smallest encoding is still far below the original capture.
  if (!smallest) throw new Error("tool image could not be encoded");
  return { base64: smallest.toString("base64"), mediaType: "image/webp" };
}
