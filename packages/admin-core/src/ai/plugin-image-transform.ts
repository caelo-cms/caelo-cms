// SPDX-License-Identifier: MPL-2.0
import type { PluginHostInfra } from "@caelo-cms/plugin-host";
import sharp from "sharp";
/** Produce a local sRGB JPEG derivative inside the requested bounds, without upscaling.
 * Decode limits and format checks apply even to images uploaded with misleading metadata. */
export const transformPluginImage: NonNullable<PluginHostInfra["imageTransform"]> = async (
  input,
) => {
  const source = sharp(input.bytes, { limitInputPixels: 40_000_000, animated: false });
  const meta = await source.metadata();
  if (!["jpeg", "png", "webp"].includes(meta.format ?? "") || (meta.pages ?? 1) > 1)
    throw new Error("PluginImageTransformFormatInvalid");
  const output = await source
    .rotate()
    .resize({ width: input.width, height: input.height, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "white" })
    .toColourspace("srgb")
    .jpeg({ quality: input.quality, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { bytes: output.data, width: output.info.width, height: output.info.height };
};
