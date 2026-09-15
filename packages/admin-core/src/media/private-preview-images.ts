// SPDX-License-Identifier: MPL-2.0

import type { PluginPrivateFiles } from "@caelo-cms/plugin-sdk";
import { Parser } from "htmlparser2";
import sharp from "sharp";

const reference = /^caelo-file:([a-f0-9-]{36}):([a-f0-9]{64})$/;

/** Resolve private references only through the caller's authorized SDK handle.
 * Browser previews stay opaque-origin and network-free: decoded raster thumbnails
 * are embedded as data URLs instead of exposing authenticated asset URLs to HTML.
 */
export async function resolvePrivatePreviewImages(
  html: string,
  getFiles: () => Promise<PluginPrivateFiles>,
): Promise<ReadonlyMap<string, string>> {
  const sources = new Set<string>();
  const parser = new Parser({
    onopentag(name, attrs) {
      if (name === "img" && attrs.src && reference.test(attrs.src)) sources.add(attrs.src);
      if (sources.size > 80) throw new Error("PrivatePreviewImageLimit");
    },
  });
  parser.end(html);
  const resolved = new Map<string, string>();
  if (!sources.size) return resolved;
  const files = await getFiles();
  let outputBytes = 0;
  async function resolve(source: string) {
    const match = reference.exec(source);
    const id = match?.[1];
    if (!match || !id) throw new Error("PrivatePreviewInvalidReference");
    const file = await files.stat({ id });
    if (file.status !== "ready" || file.sha256 !== match[2])
      throw new Error("PrivatePreviewImageUnavailable");
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.mediaType))
      throw new Error("PrivatePreviewImageType");
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < file.sizeBytes; offset += 262_144) {
      chunks.push(Buffer.from((await files.readChunk({ id, offset })).base64, "base64"));
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== file.sizeBytes) throw new Error("PrivatePreviewImageIncomplete");
    const expectedFormat = file.mediaType.slice(6);
    const signatureMatches =
      expectedFormat === "png"
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : expectedFormat === "jpeg"
          ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
          : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    if (!signatureMatches) throw new Error("PrivatePreviewImageType");
    const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: "warning" });
    const meta = await image.metadata();
    if (meta.format !== expectedFormat || (meta.pages ?? 1) !== 1)
      throw new Error("PrivatePreviewImageType");
    const thumb = await image
      .rotate()
      .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    outputBytes += thumb.length;
    if (outputBytes > 8_388_608) throw new Error("PrivatePreviewImageByteLimit");
    resolved.set(source, `data:image/webp;base64,${thumb.toString("base64")}`);
  }
  // Bound concurrent decodes and file reads: serial 4K books can exceed the
  // adapter's ten-second idle deadline before the HTML response is available.
  const queue = [...sources];
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const source = queue.shift();
        if (source) await resolve(source);
      }
    }),
  );
  return resolved;
}
