// SPDX-License-Identifier: MPL-2.0
import { createHash } from "node:crypto";
import type { PluginFonts } from "@caelo-cms/plugin-sdk";

/** Expand only exact immutable font markers after the author capability check.
 * The sandbox returns tiny references; private font bytes stay on the host. */
export async function resolvePreviewFonts(
  html: string,
  getFonts: () => Promise<PluginFonts>,
): Promise<string> {
  const markers = [...new Set(html.match(/caelo-font:[a-f0-9-]{36}:[a-f0-9]{64}/g) ?? [])];
  if (!markers.length) {
    if (html.includes("caelo-font:")) throw new Error("InvalidPreviewFontReference");
    return html;
  }
  if (markers.length > 8) throw new Error("TooManyPreviewFonts");
  const fonts = await getFonts();
  let total = 0;
  for (const marker of markers) {
    const [, id, sha256] = marker.split(":");
    if (!id || !sha256) throw new Error("InvalidPreviewFontReference");
    const ref = { id, sha256 };
    const metadata = await fonts.resolve({
      ...ref,
      use: "web",
      formats: ["ttf", "otf", "woff", "woff2"],
    });
    total += metadata.sizeBytes;
    if (total > 16 * 1024 * 1024) throw new Error("PreviewFontSizeExceeded");
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < metadata.sizeBytes; offset += 262144) {
      const chunk = await fonts.readChunk({ ...ref, offset, length: 262144 });
      chunks.push(Buffer.from(chunk.dataBase64, "base64"));
    }
    const bytes = Buffer.concat(chunks);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256)
      throw new Error("PreviewFontIntegrityMismatch");
    html = html.replaceAll(
      marker,
      `data:font/${metadata.format};base64,${bytes.toString("base64")}`,
    );
  }
  if (html.includes("caelo-font:")) throw new Error("InvalidPreviewFontReference");
  return html;
}
