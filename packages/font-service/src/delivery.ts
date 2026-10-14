// SPDX-License-Identifier: MPL-2.0
/// <reference path="./vendor-modules.d.ts" />

/**
 * Web delivery files derived from a pinned registry face.
 *
 * The font registry stores the complete, licensed original (a full TTF
 * from google/fonts is ~0.9 MB for a variable family) and pins it by
 * sha256. That file stays the source of truth and is never replaced by a
 * subset. What visitors download is derived from it here, at build time:
 *
 *  - every slice in {@link UNICODE_SUBSETS} the face has glyphs for,
 *    plus one `other` slice for the code points no named slice covers,
 *    so the delivered set is exactly as complete as the source (nothing
 *    is dropped, only split);
 *  - each slice re-encoded as WOFF2 with harfbuzz (hb-subset) and the
 *    reference woff2 encoder, both as wasm, so the generator needs no
 *    native addon and no Python;
 *  - variation axes (`wght`, `opsz`, ...) and every OpenType layout
 *    feature are kept, so `font-weight: 100 900` and feature settings
 *    behave as with the original file.
 *
 * Slices are by script, never by site text: content edits and new
 * translations cannot change a derived file. The output is a pure
 * function of (source bytes, slice table, toolchain version) — see
 * {@link deliveryToolchainTag}, which callers put into cache keys.
 *
 * Failure model (CLAUDE.md §2): any step that fails throws
 * {@link FontDeliveryError}. There is deliberately no path that hands the
 * caller the untouched source to ship instead.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import fontverter from "fontverter";
import subsetFont from "subset-font";
import { openFont } from "./inspect.js";
import { planSlices, UNICODE_SUBSETS } from "./unicode-subsets.js";

/** Slice name used when the face is delivered unsplit (fsType forbids subsetting). */
export const FULL_FACE_SUBSET = "full";

/**
 * Bumped whenever this file changes how slices are derived (flags,
 * retained tables, verification), so caches keyed on the toolchain tag
 * are invalidated even when no dependency version moved.
 */
const DELIVERY_ALGORITHM = "caelo-font-delivery/1";

/**
 * name-table records hb-subset keeps besides its default 0-6: copyright
 * (0), trademark (7), manufacturer/designer/description/URLs (8-12) and
 * the license text + URL (13, 14). The OFL lets the license travel as
 * machine-readable metadata inside the font, and a subset should not
 * strip the attribution the original carries.
 */
const PRESERVED_NAME_IDS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

/** One derived delivery file. */
export interface WebDeliveryFace {
  /** Slice name (`latin`, `cyrillic`, `other`, or `full`). */
  readonly subset: string;
  /** CSS `unicode-range` for the slice; `null` for an unsplit face. */
  readonly unicodeRange: string | null;
  /** WOFF2 bytes. */
  readonly bytes: Uint8Array;
}

/** Everything a page needs to deliver one pinned face. */
export interface WebDelivery {
  /** False when OS/2 fsType forbids subsetting and the face ships whole. */
  readonly split: boolean;
  /** In CSS declaration order (least-needed slice first, `latin` last). */
  readonly faces: readonly WebDeliveryFace[];
}

/** Structured failure: which source, which slice, what went wrong. */
export class FontDeliveryError extends Error {
  readonly code = "FontDeliveryFailed";
  constructor(
    readonly sourceSha256: string,
    readonly subset: string,
    readonly reason: string,
  ) {
    super(`FontDeliveryFailed:${subset}:${reason}`);
    this.name = "FontDeliveryError";
  }
}

const nodeRequire = createRequire(import.meta.url);

function packageVersion(packageJsonPath: string): string {
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string") throw new Error(`no version in ${packageJsonPath}`);
  return parsed.version;
}

let toolchainTag: string | null = null;

/**
 * Short, stable id of the code that derives delivery files: the installed
 * versions of subset-font, harfbuzzjs (resolved the way subset-font
 * resolves it), fontverter and wawoff2 (resolved the way fontverter
 * does), plus the slice table and {@link DELIVERY_ALGORITHM}. Read from
 * the installed packages rather than hard-coded so a dependency bump can
 * never reuse files an older encoder produced.
 */
export function deliveryToolchainTag(): string {
  if (toolchainTag !== null) return toolchainTag;
  const subsetFontMain = nodeRequire.resolve("subset-font");
  const fontverterMain = nodeRequire.resolve("fontverter");
  const fromSubsetFont = createRequire(subsetFontMain);
  const fromFontverter = createRequire(fontverterMain);
  // harfbuzzjs' `exports` map hides package.json; the wasm path is exported.
  const harfbuzzWasm = fromSubsetFont.resolve("harfbuzzjs/dist/harfbuzz-subset.wasm");
  const versions = [
    `subset-font@${packageVersion(join(dirname(subsetFontMain), "package.json"))}`,
    `harfbuzzjs@${packageVersion(join(dirname(harfbuzzWasm), "..", "package.json"))}`,
    `fontverter@${packageVersion(join(dirname(fontverterMain), "package.json"))}`,
    `wawoff2@${packageVersion(fromFontverter.resolve("wawoff2/package.json"))}`,
  ];
  toolchainTag = createHash("sha256")
    .update([DELIVERY_ALGORITHM, ...versions, JSON.stringify(UNICODE_SUBSETS)].join("\n"))
    .digest("hex")
    .slice(0, 12);
  return toolchainTag;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface AxisRange {
  readonly min: number;
  readonly max: number;
}

function axesOf(font: unknown): Record<string, AxisRange> {
  const axes = (font as { variationAxes?: Record<string, AxisRange> }).variationAxes ?? {};
  return Object.fromEntries(
    Object.entries(axes).map(([tag, a]) => [tag, { min: a.min, max: a.max }]),
  );
}

/**
 * Re-open a derived file and check it is a WOFF2 that maps every code
 * point it was cut for and kept the source's variation axes. A slice that
 * silently lost glyphs or axes would render as fallback text in
 * production, so it is a build failure here.
 */
function verifySlice(
  sourceSha256: string,
  subset: string,
  bytes: Uint8Array,
  expectedAxes: Record<string, AxisRange>,
  codePoints: readonly number[] | null,
): void {
  if (Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "wOF2") {
    throw new FontDeliveryError(sourceSha256, subset, "OutputNotWoff2");
  }
  let font: ReturnType<typeof openFont>["font"];
  try {
    font = openFont(bytes).font;
  } catch (error) {
    throw new FontDeliveryError(sourceSha256, subset, `OutputUnreadable:${describe(error)}`);
  }
  if (JSON.stringify(axesOf(font)) !== JSON.stringify(expectedAxes)) {
    throw new FontDeliveryError(sourceSha256, subset, "VariationAxesLost");
  }
  if (codePoints !== null) {
    const mapped = new Set(font.characterSet);
    const missing = codePoints.find((cp) => !mapped.has(cp));
    if (missing !== undefined) {
      throw new FontDeliveryError(
        sourceSha256,
        subset,
        `CodePointDropped:U+${missing.toString(16).toUpperCase()}`,
      );
    }
  }
}

async function step<T>(sourceSha256: string, subset: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof FontDeliveryError) throw error;
    throw new FontDeliveryError(sourceSha256, subset, `TranscodeFailed:${describe(error)}`);
  }
}

/**
 * Derive the WOFF2 delivery slices for one face. Accepts TTF, OTF, WOFF
 * and WOFF2 sources; a compressed source is decoded to sfnt once and
 * encoded once, never compressed on top of its existing compression.
 *
 * @throws FontDeliveryError when the source cannot be read, a slice
 *   cannot be produced, or a produced slice fails verification.
 */
export async function deriveWebDelivery(source: Uint8Array): Promise<WebDelivery> {
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  let opened: ReturnType<typeof openFont>;
  try {
    opened = openFont(source);
  } catch (error) {
    throw new FontDeliveryError(sourceSha256, "source", `SourceUnreadable:${describe(error)}`);
  }
  const { font, format } = opened;
  const expectedAxes = axesOf(font);
  const fsType = (font as unknown as { "OS/2"?: { fsType?: { noSubsetting?: boolean } } })["OS/2"]
    ?.fsType;

  if (fsType?.noSubsetting) {
    // OS/2 fsType bit 8 ("no subsetting"): the foundry permits embedding
    // only of the complete font. Splitting into slices IS subsetting, so
    // the face ships whole. Changing the container to WOFF2 is lossless
    // and not subsetting, so the size win from compression is still taken;
    // a WOFF2 source is shipped as-is (no second compression pass).
    const bytes =
      format === "woff2"
        ? source
        : new Uint8Array(
            await step(sourceSha256, FULL_FACE_SUBSET, () =>
              fontverter.convert(Buffer.from(source), "woff2"),
            ),
          );
    verifySlice(sourceSha256, FULL_FACE_SUBSET, bytes, expectedAxes, null);
    return { split: false, faces: [{ subset: FULL_FACE_SUBSET, unicodeRange: null, bytes }] };
  }

  const sfnt =
    format === "ttf" || format === "otf"
      ? Buffer.from(source)
      : await step(sourceSha256, "source", () => fontverter.convert(Buffer.from(source), "sfnt"));

  // Only code points that map to a real glyph: format-4 cmaps end with a
  // U+FFFF segment pointing at .notdef, which is not a character the face
  // can draw and would yield an empty slice.
  const charset = [...new Set(font.characterSet)]
    .filter((cp) => font.hasGlyphForCodePoint(cp))
    .sort((a, z) => a - z);
  const plan = planSlices(charset);

  const faces: WebDeliveryFace[] = [];
  for (const slice of plan) {
    const text = slice.codePoints.map((cp) => String.fromCodePoint(cp)).join("");
    const bytes = new Uint8Array(
      await step(sourceSha256, slice.name, () =>
        subsetFont(sfnt, text, { targetFormat: "woff2", preserveNameIds: PRESERVED_NAME_IDS }),
      ),
    );
    verifySlice(sourceSha256, slice.name, bytes, expectedAxes, slice.codePoints);
    faces.push({ subset: slice.name, unicodeRange: slice.unicodeRange, bytes });
  }
  if (faces.length === 0) {
    throw new FontDeliveryError(sourceSha256, "source", "NoMappedCodePoints");
  }
  return { split: true, faces };
}
