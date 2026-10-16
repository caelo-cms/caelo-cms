// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { deriveDefaultAxisSpec, type EffectiveAxisSpec } from "@caelo-cms/shared";
import fontverter from "fontverter";
import {
  deliveryToolchainTag,
  deriveWebDelivery,
  FontDeliveryError,
  verifyDeliveredSlice,
} from "./delivery.js";
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

/** Noto Sans Regular is a static face: no axes, so its spec is empty. */
const STATIC: EffectiveAxisSpec = {};
const INTER_FULL: EffectiveAxisSpec = {
  opsz: { mode: "full", min: 14, max: 32 },
  wght: { mode: "full", min: 100, max: 900 },
};
const INTER_AXES = {
  opsz: { min: 14, max: 32, default: 14 },
  wght: { min: 100, max: 900, default: 400 },
};

function axesOfFile(bytes: Uint8Array): Record<string, { min: number; max: number }> {
  return (
    openFont(bytes).font as unknown as {
      variationAxes: Record<string, { min: number; max: number }>;
    }
  ).variationAxes;
}

function axesOfFileSorted(bytes: Uint8Array): Record<string, { min: number; max: number }> {
  const axes = axesOfFile(bytes);
  return Object.fromEntries(
    Object.keys(axes)
      .sort()
      .map((tag) => [tag, { min: axes[tag]!.min, max: axes[tag]!.max }]),
  );
}

function totalBytes(delivery: { faces: readonly { bytes: Uint8Array }[] }): number {
  return delivery.faces.reduce((n, f) => n + f.bytes.length, 0);
}

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
    const delivery = await deriveWebDelivery(notoWoff, STATIC);
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
    const delivery = await deriveWebDelivery(interWoff2, INTER_FULL);
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

  test("keeps the variation axes of a variable face under a full spec", async () => {
    const source = openFont(interWoff2).font as unknown as {
      variationAxes: Record<string, { min: number; max: number }>;
    };
    expect(Object.keys(source.variationAxes).sort()).toEqual(["opsz", "wght"]);
    for (const face of (await deriveWebDelivery(interWoff2, INTER_FULL)).faces) {
      const axes = axesOfFile(face.bytes);
      expect(axes.wght).toMatchObject({ min: 100, max: 900 });
      expect(axes.opsz).toMatchObject({ min: 14, max: 32 });
    }
  });

  test("keeps opt-in OpenType features in the latin slice (deliberate size trade-off)", async () => {
    // Google Fonts' default Inter slice drops these (and pins opsz), which is
    // most of why its latin file is smaller. A site may turn them on through
    // font-feature-settings / font-variant-*, so stripping them would change
    // rendering. This test stops a size "optimisation" from removing them silently.
    const latin = (await deriveWebDelivery(interWoff2, INTER_FULL)).faces.find(
      (f) => f.subset === "latin",
    )!;
    const features = new Set(
      (openFont(latin.bytes).font as unknown as { availableFeatures: string[] }).availableFeatures,
    );
    for (const tag of ["kern", "tnum", "frac", "sups", "salt", "ss05", "cv01", "cv11"]) {
      expect(features.has(tag)).toBe(true);
    }
  });

  test("is deterministic and independent of the source container", async () => {
    const first = await deriveWebDelivery(notoWoff, STATIC);
    const second = await deriveWebDelivery(notoWoff, STATIC);
    const fromTtf = await deriveWebDelivery(await fontverter.convert(notoWoff, "sfnt"), STATIC);
    const bytes = (d: typeof first) => d.faces.map((f) => Buffer.from(f.bytes).toString("hex"));
    expect(bytes(second)).toEqual(bytes(first));
    expect(bytes(fromTtf)).toEqual(bytes(first));
    expect(deliveryToolchainTag()).toMatch(/^[0-9a-f]{12}$/);
    expect(deliveryToolchainTag()).toBe(deliveryToolchainTag());
  });

  test("honours fsType noSubsetting: one whole-face WOFF2, no unicode-range", async () => {
    const restricted = await withNoSubsetting(interWoff2);
    const delivery = await deriveWebDelivery(restricted, INTER_FULL);
    expect(delivery.split).toBe(false);
    expect(delivery.faces).toHaveLength(1);
    const [face] = delivery.faces;
    expect(face?.subset).toBe("full");
    expect(face?.unicodeRange).toBeNull();
    expect(Buffer.from(face!.bytes.subarray(0, 4)).toString("ascii")).toBe("wOF2");
    expect(mappedCodePoints(face!.bytes)).toEqual(mappedCodePoints(restricted));

    // A WOFF2 source that forbids subsetting ships as-is: no second compression pass.
    const restrictedWoff2 = await fontverter.convert(restricted, "woff2");
    const passthrough = await deriveWebDelivery(restrictedWoff2, INTER_FULL);
    expect(Buffer.from(passthrough.faces[0]!.bytes).equals(restrictedWoff2)).toBe(true);

    // Instancing modifies the face too, so a restricted face never gets a non-full spec.
    const instanced = await deriveWebDelivery(restricted, {
      ...INTER_FULL,
      opsz: { mode: "pin", value: 14 },
    }).catch((e: unknown) => e);
    expect(instanced).toMatchObject({
      code: "FontDeliveryFailed",
      reason: "AxisInstancingForbidden",
    });
  });

  test("instances axes to the spec: pinned axes vanish, ranged axes are clamped", async () => {
    const spec: EffectiveAxisSpec = {
      opsz: { mode: "pin", value: 14 },
      wght: { mode: "range", min: 400, max: 700 },
    };
    const delivery = await deriveWebDelivery(interWoff2, spec);
    expect(delivery.faces.map((f) => f.subset)).toEqual([
      "other",
      "cyrillic",
      "greek",
      "vietnamese",
      "latin-ext",
      "latin",
    ]);
    for (const face of delivery.faces) {
      const axes = axesOfFile(face.bytes);
      expect(Object.keys(axes)).toEqual(["wght"]);
      expect(axes.wght).toMatchObject({ min: 400, max: 700 });
    }
    // Every axis pinned: the delivered file is a static instance.
    const pinned = await deriveWebDelivery(interWoff2, {
      opsz: { mode: "pin", value: 32 },
      wght: { mode: "pin", value: 600 },
    });
    for (const face of pinned.faces) expect(axesOfFile(face.bytes)).toEqual({});
  });

  test("the default policy shrinks an Inter-like face (regression guard for the LCP fix)", async () => {
    // A typical site: theme 400/700, UA bold + the bolder closure → 900.
    const spec = deriveDefaultAxisSpec(
      INTER_AXES,
      { weights: [400, 700, 900], variationSettingsAxes: [] },
      true,
    );
    expect(spec).toEqual({
      opsz: { mode: "pin", value: 14 },
      wght: { mode: "range", min: 400, max: 900 },
    });
    const full = await deriveWebDelivery(interWoff2, INTER_FULL);
    const reduced = await deriveWebDelivery(interWoff2, spec);
    expect(totalBytes(reduced)).toBeLessThan(totalBytes(full) * 0.85);
    const latin = (d: typeof full) => d.faces.find((f) => f.subset === "latin")!.bytes.length;
    expect(latin(reduced)).toBeLessThan(latin(full));
  });

  test("rejects a spec that does not describe the source's axes", async () => {
    const missing = await deriveWebDelivery(interWoff2, {
      wght: { mode: "full", min: 100, max: 900 },
    }).catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: "FontDeliveryFailed", subset: "source" });
    expect((missing as Error).message).toContain("AxisSpecMismatch");
    const outside = await deriveWebDelivery(interWoff2, {
      ...INTER_FULL,
      wght: { mode: "range", min: 50, max: 700 },
    }).catch((e: unknown) => e);
    expect((outside as Error).message).toContain("AxisSpecOutOfRange");
  });

  test("verification rejects a slice whose axes differ from the expected instancing result", async () => {
    const [face] = (await deriveWebDelivery(interWoff2, INTER_FULL)).faces;
    const codePoints = mappedCodePoints(face!.bytes);
    // Passes against what it really carries …
    expect(() =>
      verifyDeliveredSlice("sha", "other", face!.bytes, axesOfFileSorted(face!.bytes), codePoints),
    ).not.toThrow();
    // … but a full-axis file is not what a pinned-opsz spec promised.
    const wrong = (() => {
      try {
        verifyDeliveredSlice("sha", "other", face!.bytes, { wght: { min: 400, max: 700 } }, null);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(wrong).toBeInstanceOf(FontDeliveryError);
    expect((wrong as FontDeliveryError).reason).toMatch(/^VariationAxesMismatch:/);
    // A dropped code point is still caught.
    expect(() =>
      verifyDeliveredSlice("sha", "other", face!.bytes, axesOfFileSorted(face!.bytes), [0x5a]),
    ).toThrow(/CodePointDropped:U\+5A/);
  });

  test("fails loudly with a structured error instead of handing back the source", async () => {
    const sfnt = Buffer.from(await fontverter.convert(notoWoff, "sfnt"));
    const broken = Buffer.from(sfnt);
    const maxp = tableOf(broken, "maxp");
    broken.fill(0xff, maxp.offset, maxp.offset + maxp.length);
    const error = await deriveWebDelivery(broken, STATIC).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FontDeliveryError);
    expect(error).toMatchObject({ code: "FontDeliveryFailed", subset: "vietnamese" });
    expect((error as Error).message).toMatch(/^FontDeliveryFailed:vietnamese:TranscodeFailed:/);

    const unreadable = await deriveWebDelivery(new Uint8Array(64), STATIC).catch((e: unknown) => e);
    expect(unreadable).toMatchObject({ code: "FontDeliveryFailed", subset: "source" });
  });
});
