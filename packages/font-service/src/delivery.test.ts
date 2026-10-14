// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import fontverter from "fontverter";
import { deliveryToolchainTag, deriveWebDelivery, FontDeliveryError } from "./delivery.js";
import { openFont } from "./inspect.js";
import { inRanges, parseUnicodeRange, UNICODE_SUBSETS } from "./unicode-subsets.js";

function fixture(name: string): Buffer {
  return Buffer.from(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").trim(),
    "base64",
  );
}
const notoWoff = fixture("NotoSans-Regular.base64.txt");
const interWoff2 = fixture("InterVariable-mini.woff2.base64.txt");

function mappedCodePoints(bytes: Uint8Array): number[] {
  const { font } = openFont(bytes);
  return font.characterSet.filter((cp) => font.hasGlyphForCodePoint(cp)).sort((a, z) => a - z);
}

function tableOf(sfnt: Buffer, tag: string): { offset: number; length: number } {
  for (let i = 0; i < sfnt.readUInt16BE(4); i++) {
    const entry = 12 + 16 * i;
    if (sfnt.toString("ascii", entry, entry + 4) === tag) {
      return { offset: sfnt.readUInt32BE(entry + 8), length: sfnt.readUInt32BE(entry + 12) };
    }
  }
  throw new Error(`fixture has no ${tag} table`);
}

/** Set OS/2 fsType bit 8 ("no subsetting") on an sfnt copy. */
async function withNoSubsetting(source: Buffer): Promise<Buffer> {
  const sfnt = Buffer.from(await fontverter.convert(source, "sfnt"));
  const os2 = tableOf(sfnt, "OS/2");
  sfnt.writeUInt16BE(sfnt.readUInt16BE(os2.offset + 8) | 0x0100, os2.offset + 8);
  return sfnt;
}

describe("deriveWebDelivery", () => {
  test("emits valid WOFF2 slices only for the scripts the face covers", async () => {
    const delivery = await deriveWebDelivery(notoWoff);
    expect(delivery.split).toBe(true);
    // The fixture maps Latin + Vietnamese letters; its only Cyrillic-range code
    // point (U+0301, shared with vietnamese) does not earn a Cyrillic file.
    expect(delivery.faces.map((f) => f.subset)).toEqual(["vietnamese", "latin"]);
    for (const face of delivery.faces) {
      expect(Buffer.from(face.bytes.subarray(0, 4)).toString("ascii")).toBe("wOF2");
      // Decodes to a plain sfnt: one WOFF2 layer, not WOFF2 wrapped around WOFF.
      const decoded = await fontverter.convert(Buffer.from(face.bytes), "sfnt");
      expect(decoded.readUInt32BE(0)).toBe(0x00010000);
      expect(openFont(face.bytes).format).toBe("woff2");
    }
  });

  test("slices carry the standard unicode-ranges and together cover every source code point", async () => {
    const delivery = await deriveWebDelivery(interWoff2);
    expect(delivery.faces.map((f) => f.subset)).toEqual([
      "other",
      "cyrillic",
      "greek",
      "vietnamese",
      "latin-ext",
      "latin",
    ]);
    const standard = new Map(UNICODE_SUBSETS.map((s) => [s.name, s.unicodeRange]));
    const other = delivery.faces[0];
    expect(other?.unicodeRange).toBe("U+2192"); // →, outside every named slice
    const delivered = new Set<number>();
    for (const face of delivery.faces) {
      if (face.subset !== "other") expect(face.unicodeRange).toBe(standard.get(face.subset)!);
      const ranges = parseUnicodeRange(face.unicodeRange!);
      for (const cp of mappedCodePoints(face.bytes)) {
        expect(inRanges(cp, ranges)).toBe(true);
        delivered.add(cp);
      }
    }
    expect([...delivered].sort((a, z) => a - z)).toEqual(mappedCodePoints(interWoff2));
    const cyrillic = delivery.faces.find((f) => f.subset === "cyrillic")!;
    expect(mappedCodePoints(cyrillic.bytes)).toEqual([0x414, 0x434]);
  });

  test("keeps the variation axes of a variable face", async () => {
    const source = openFont(interWoff2).font as unknown as {
      variationAxes: Record<string, { min: number; max: number }>;
    };
    expect(Object.keys(source.variationAxes).sort()).toEqual(["opsz", "wght"]);
    for (const face of (await deriveWebDelivery(interWoff2)).faces) {
      const axes = (
        openFont(face.bytes).font as unknown as {
          variationAxes: Record<string, { min: number; max: number }>;
        }
      ).variationAxes;
      expect(axes.wght).toMatchObject({ min: 100, max: 900 });
      expect(axes.opsz).toMatchObject({ min: 14, max: 32 });
    }
  });

  test("keeps opt-in OpenType features in the latin slice (deliberate size trade-off)", async () => {
    // Google Fonts' default Inter slice drops these (and pins opsz), which is
    // most of why its latin file is smaller. A site may turn them on through
    // font-feature-settings / font-variant-*, so stripping them would change
    // rendering. This test stops a size "optimisation" from removing them silently.
    const latin = (await deriveWebDelivery(interWoff2)).faces.find((f) => f.subset === "latin")!;
    const features = new Set(
      (openFont(latin.bytes).font as unknown as { availableFeatures: string[] }).availableFeatures,
    );
    for (const tag of ["kern", "tnum", "frac", "sups", "salt", "ss05", "cv01", "cv11"]) {
      expect(features.has(tag)).toBe(true);
    }
  });

  test("is deterministic and independent of the source container", async () => {
    const first = await deriveWebDelivery(notoWoff);
    const second = await deriveWebDelivery(notoWoff);
    const fromTtf = await deriveWebDelivery(await fontverter.convert(notoWoff, "sfnt"));
    const bytes = (d: typeof first) => d.faces.map((f) => Buffer.from(f.bytes).toString("hex"));
    expect(bytes(second)).toEqual(bytes(first));
    expect(bytes(fromTtf)).toEqual(bytes(first));
    expect(deliveryToolchainTag()).toMatch(/^[0-9a-f]{12}$/);
    expect(deliveryToolchainTag()).toBe(deliveryToolchainTag());
  });

  test("honours fsType noSubsetting: one whole-face WOFF2, no unicode-range", async () => {
    const restricted = await withNoSubsetting(interWoff2);
    const delivery = await deriveWebDelivery(restricted);
    expect(delivery.split).toBe(false);
    expect(delivery.faces).toHaveLength(1);
    const [face] = delivery.faces;
    expect(face?.subset).toBe("full");
    expect(face?.unicodeRange).toBeNull();
    expect(Buffer.from(face!.bytes.subarray(0, 4)).toString("ascii")).toBe("wOF2");
    expect(mappedCodePoints(face!.bytes)).toEqual(mappedCodePoints(restricted));

    // A WOFF2 source that forbids subsetting ships as-is: no second compression pass.
    const restrictedWoff2 = await fontverter.convert(restricted, "woff2");
    const passthrough = await deriveWebDelivery(restrictedWoff2);
    expect(Buffer.from(passthrough.faces[0]!.bytes).equals(restrictedWoff2)).toBe(true);
  });

  test("fails loudly with a structured error instead of handing back the source", async () => {
    const sfnt = Buffer.from(await fontverter.convert(notoWoff, "sfnt"));
    const broken = Buffer.from(sfnt);
    const maxp = tableOf(broken, "maxp");
    broken.fill(0xff, maxp.offset, maxp.offset + maxp.length);
    const error = await deriveWebDelivery(broken).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FontDeliveryError);
    expect(error).toMatchObject({ code: "FontDeliveryFailed", subset: "vietnamese" });
    expect((error as Error).message).toMatch(/^FontDeliveryFailed:vietnamese:TranscodeFailed:/);

    const unreadable = await deriveWebDelivery(new Uint8Array(64)).catch((e: unknown) => e);
    expect(unreadable).toMatchObject({ code: "FontDeliveryFailed", subset: "source" });
  });
});
