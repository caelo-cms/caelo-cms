// SPDX-License-Identifier: MPL-2.0
/**
 * v0.11.1 (issue #76) — UI-side OKLCh / sRGB color helpers.
 *
 * Single import point for `colorjs.io` so the color editor + contrast
 * badge + ramp preview all consume one wrapper instead of importing
 * the package directly. Keeps the bundle's import graph tight + makes
 * a future swap to a lighter color lib a one-file change.
 */
import Color from "colorjs.io";
export class InvalidColorInput extends Error {
    input;
    constructor(input) {
        super(`InvalidColorInput: '${input}' is not a recognised CSS color — pass hex, oklch(L C H), rgb(...), hsl(...), etc.`);
        this.name = "InvalidColorInput";
        this.input = input;
    }
}
/**
 * Parse any CSS color string into both sRGB and OKLCh tuples plus
 * canonical hex + oklch() string representations. Throws
 * `InvalidColorInput` on parse failure.
 */
export function parseColor(input) {
    if (typeof input !== "string" || input.trim().length === 0) {
        throw new InvalidColorInput(String(input));
    }
    let c;
    try {
        c = new Color(input);
    }
    catch (_e) {
        throw new InvalidColorInput(input);
    }
    const srgb = c.to("srgb").coords;
    const oklch = c.to("oklch").coords;
    const hex = toHex(srgb);
    const oklchString = formatOklch(oklch);
    return { srgb, oklch, hex, oklchString };
}
/**
 * Format an OKLCh tuple as the W3C-standard `oklch(L C H)` string.
 * Three decimal places — matches the server-side ramp generator
 * so client-side previews stay byte-identical to derived ramp stops.
 */
export function formatOklch(coords) {
    // colorjs.io returns `null` (not NaN) for the hue of an achromatic
    // color like `#ffffff` / `#000000` / gray; coerce both null and NaN
    // to 0 so the OKLCh string is well-formed and downstream
    // `.toFixed(3)` doesn't throw on null.
    const fmt = (n) => {
        if (n == null || !Number.isFinite(n))
            return "0";
        return n.toFixed(3).replace(/\.?0+$/, "") || "0";
    };
    return `oklch(${fmt(coords[0])} ${fmt(coords[1])} ${fmt(coords[2])})`;
}
/**
 * Convert an sRGB tuple (0..1) into a `#rrggbb` hex string. Clamps
 * out-of-gamut values to 0..1 first so a wide-gamut OKLCh source
 * produces a valid hex output for the `<input type="color">` fallback
 * picker.
 */
export function toHex(srgb) {
    const [r, g, b] = srgb.map((c) => Math.max(0, Math.min(1, c)));
    const hh = (n) => Math.round(n * 255)
        .toString(16)
        .padStart(2, "0");
    return `#${hh(r)}${hh(g)}${hh(b)}`;
}
