// SPDX-License-Identifier: MPL-2.0

// Neither package ships type declarations (no @types either). Only the
// surface delivery.ts calls is declared; widen it when a new option is used.

declare module "subset-font" {
  interface SubsetFontOptions {
    readonly targetFormat?: "sfnt" | "truetype" | "woff" | "woff2";
    readonly preserveNameIds?: readonly number[];
    /** Per axis: a number pins it, `{min, max}` clamps it (harfbuzz instancer). */
    readonly variationAxes?: Readonly<
      Record<string, number | { readonly min: number; readonly max: number }>
    >;
  }
  function subsetFont(font: Buffer, text: string, options?: SubsetFontOptions): Promise<Buffer>;
  export default subsetFont;
}

declare module "fontverter" {
  type Format = "sfnt" | "truetype" | "woff" | "woff2";
  const fontverter: {
    convert(font: Buffer, toFormat: Format, fromFormat?: Format): Promise<Buffer>;
  };
  export default fontverter;
}
