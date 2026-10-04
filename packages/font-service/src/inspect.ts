// SPDX-License-Identifier: MPL-2.0
import { createHash } from "node:crypto";
import fontkit from "@pdf-lib/fontkit";
import type { FontMetadata } from "./types.js";

export const MAX_FONT_BYTES = 8 * 1024 * 1024;
const MAX_SFNT_BYTES = 16 * 1024 * 1024;

/** Validate container sizes before the parser allocates decompressed tables. */
export function openFont(bytes: Uint8Array) {
  if (bytes.length < 48 || bytes.length > MAX_FONT_BYTES) throw new Error("FontSizeInvalid");
  const data = Buffer.from(bytes);
  const signature = data.toString("ascii", 0, 4);
  let format: FontMetadata["format"];
  if (signature === "wOFF" || signature === "wOF2") {
    format = signature === "wOFF" ? "woff" : "woff2";
    if (
      data.readUInt32BE(8) !== data.length ||
      data.readUInt32BE(16) > MAX_SFNT_BYTES ||
      data.readUInt16BE(12) > 256
    )
      throw new Error("FontContainerInvalid");
    if (data.toString("ascii", 4, 8) === "ttcf") throw new Error("FontCollectionsUnsupported");
  } else if (signature === "OTTO" || data.readUInt32BE(0) === 0x00010000) {
    format = signature === "OTTO" ? "otf" : "ttf";
    const tables = data.readUInt16BE(4);
    if (tables > 256 || 12 + tables * 16 > data.length) throw new Error("FontContainerInvalid");
    for (let i = 0; i < tables; i++) {
      const entry = 12 + i * 16;
      if (data.readUInt32BE(entry + 8) + data.readUInt32BE(entry + 12) > data.length)
        throw new Error("FontTableInvalid");
    }
  } else throw new Error("FontFormatUnsupported");
  const font = fontkit.create(data);
  // Fontkit decodes directories lazily. Bound every declared output table before
  // accessing name/cmap (which decompresses WOFF/WOFF2 content).
  const directory = (
    font as unknown as {
      directory?: {
        tables?: Record<
          string,
          { length: number; transformLength?: number; offset?: number; compLength?: number }
        >;
      };
    }
  ).directory;
  const tables = Object.values(directory?.tables ?? {});
  if (tables.length > 256) throw new Error("FontContainerInvalid");
  let expanded = 0;
  for (const table of tables) {
    if (!Number.isSafeInteger(table.length) || table.length < 0 || table.length > MAX_SFNT_BYTES)
      throw new Error("FontTableInvalid");
    expanded += Math.max(table.length, table.transformLength ?? 0);
    if (expanded > MAX_SFNT_BYTES) throw new Error("FontDecompressionLimit");
    if (
      format === "woff" &&
      ((table.offset ?? 0) + (table.compLength ?? 0) > data.length ||
        (table.compLength ?? 0) > table.length)
    )
      throw new Error("FontTableInvalid");
  }

  if (!("characterSet" in font) || !("familyName" in font))
    throw new Error("FontCollectionsUnsupported");
  if (
    !font.familyName ||
    font.familyName.length > 200 ||
    font.numGlyphs < 1 ||
    font.numGlyphs > 65535
  )
    throw new Error("FontMetadataInvalid");
  // Force cmap/table decoding now, so malformed fonts never become ready assets.
  if (font.characterSet.length > 1_114_112) throw new Error("FontCharacterSetInvalid");
  return { font, format };
}

export function inspectFontBytes(bytes: Uint8Array, license: FontMetadata["license"]) {
  const { font, format } = openFont(bytes);
  const names = font as unknown as { getName(key: string): string | null };
  const family = names.getName("preferredFamily") ?? font.familyName;
  if (!family) throw new Error("FontFamilyMissing");
  const os2 = (
    font as unknown as {
      "OS/2"?: {
        usWeightClass?: number;
        fsType?: { noEmbedding?: boolean; bitmapOnly?: boolean; noSubsetting?: boolean };
        fsSelection?: { italic?: boolean } | number;
      };
    }
  )["OS/2"];
  const fsType = os2?.fsType ?? {};
  const restricted = Boolean(fsType.noEmbedding || fsType.bitmapOnly);
  const restriction = restricted ? "Font embedding is restricted by OS/2 fsType" : null;
  const axes = Object.fromEntries(
    Object.entries(
      (
        font as unknown as {
          variationAxes?: Record<string, { min: number; max: number; default: number }>;
        }
      ).variationAxes ?? {},
    ).map(([tag, axis]) => [tag, { min: axis.min, max: axis.max, default: axis.default }]),
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    sha256,
    family,
    subfamily: names.getName("preferredSubfamily") ?? font.subfamilyName ?? "Regular",
    postscriptName: font.postscriptName ?? family,
    cssFamily: `CaeloFont_${sha256}`,
    format,
    weight: os2?.usWeightClass ?? 400,
    style: (font.italicAngle !== 0 ? "italic" : "normal") as "normal" | "italic",
    axes,
    sizeBytes: bytes.length,
    glyphCount: font.numGlyphs,
    embedding: {
      web: license.webEmbedding && !restricted,
      document: license.documentEmbedding && !restricted,
      subset: !fsType.noSubsetting,
      restriction,
    },
  };
}

export function missingCharacters(bytes: Uint8Array, text: string): string[] {
  const { font } = openFont(bytes);
  return [
    ...new Set(
      [...text].filter(
        (c) => !/[\r\n\t]/u.test(c) && !font.hasGlyphForCodePoint(c.codePointAt(0) ?? 0),
      ),
    ),
  ];
}
