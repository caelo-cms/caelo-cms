// SPDX-License-Identifier: MPL-2.0
/**
 * issue #153 regression — gradient tokens must be settable end to end.
 *
 * Two live-run failures this covers (the #1 red-error class in migration
 * chat):
 *
 *   1. `UnknownTokenName: cannot infer canonical path for 'gradient'` —
 *      the normalizer had no gradient category, so every loose gradient
 *      name (`gradient`, `heroGradient`, `gradient.hero`) threw.
 *   2. `theme document invalid after edit: … gradient token invalid:
 *      expected "gradient"` — a gradient written to `gradient.hero` got
 *      `$type: "dimension"` because `inferTypeFromPath` had no gradient
 *      case and fell through to sniffing the (unrecognised) gradient
 *      string.
 *
 * The assertions therefore exercise BOTH the normalizer's canonical-path
 * + $type inference AND the exact document validator that produced
 * error #2 (`validateThemeTokens`).
 */
import { describe, expect, it } from "bun:test";
import { normalizeTokens } from "./theme-normalize.js";
import { applyDtcgWrites, validateThemeTokens } from "./themes.js";

const HERO_CSS = "linear-gradient(135deg, #4f46e5, #7c3aed)";

/** Normalize → apply → validate, returning the written leaf. */
function roundTrip(set: Record<string, unknown>): { leaf: unknown; path: string } {
  const normalized = normalizeTokens(set);
  const path = normalized.canonicalPaths[0]!;
  const doc = applyDtcgWrites({}, normalized.set, normalized.types);
  // The exact validator that threw `gradient token invalid` in prod.
  const validated = validateThemeTokens(doc);
  const leaf = (validated.gradient as Record<string, unknown>)?.[path.split(".")[1]!];
  return { leaf, path };
}

describe("normalizeTokens — gradient canonicalisation (#153)", () => {
  it.each([
    ["gradient", "gradient.hero"],
    ["heroGradient", "gradient.hero"],
    ["gradientHero", "gradient.hero"],
    ["gradient.hero", "gradient.hero"],
    ["gradient.subtle", "gradient.subtle"],
    ["--gradient-hero", "gradient.hero"],
  ])("canonicalises loose name %p → %p with $type gradient", (name, expectedPath) => {
    const r = normalizeTokens({ [name]: HERO_CSS });
    expect(r.canonicalPaths).toEqual([expectedPath]);
    expect(r.types[expectedPath]).toBe("gradient");
    expect(r.set[expectedPath]).toBe(HERO_CSS);
  });

  it("no longer throws UnknownTokenName for a bare `gradient` name", () => {
    expect(() => normalizeTokens({ gradient: HERO_CSS })).not.toThrow();
  });
});

describe("gradient tokens pass the DTCG document validator (#153)", () => {
  it("bare CSS string on a loose name validates as $type gradient", () => {
    const { leaf } = roundTrip({ heroGradient: HERO_CSS });
    expect(leaf).toEqual({ $value: HERO_CSS, $type: "gradient" });
  });

  it("direct DTCG path `gradient.hero` no longer stamps $type dimension (error #2)", () => {
    const { leaf } = roundTrip({ "gradient.hero": HERO_CSS });
    expect(leaf).toEqual({ $value: HERO_CSS, $type: "gradient" });
    // The precise regression: $type must be the literal "gradient".
    expect((leaf as Record<string, unknown>).$type).toBe("gradient");
  });

  it("accepts the full DTCG envelope the tool guidance documents", () => {
    const { leaf } = roundTrip({
      "gradient.hero": { $type: "gradient", $value: HERO_CSS },
    });
    expect(leaf).toEqual({ $value: HERO_CSS, $type: "gradient" });
  });

  it("accepts a JSON-encoded envelope string", () => {
    const { leaf } = roundTrip({
      "gradient.hero": JSON.stringify({ $type: "gradient", $value: HERO_CSS }),
    });
    expect(leaf).toEqual({ $value: HERO_CSS, $type: "gradient" });
  });

  it("folds a structured {type, angle, stops} object into a CSS string", () => {
    const { leaf } = roundTrip({
      "gradient.hero": {
        type: "linear",
        angle: 135,
        stops: [{ color: "#4f46e5" }, { color: "#7c3aed", position: 100 }],
      },
    });
    expect(leaf).toEqual({
      $value: "linear-gradient(135deg, #4f46e5, #7c3aed 100%)",
      $type: "gradient",
    });
  });

  it("defaults a bare {stops} structured object to a diagonal linear sweep", () => {
    const { leaf } = roundTrip({
      "gradient.subtle": { stops: ["#ffffff", "#f1f5f9"] },
    });
    expect(leaf).toEqual({
      $value: "linear-gradient(135deg, #ffffff, #f1f5f9)",
      $type: "gradient",
    });
  });

  it("renders a radial gradient without inventing an angle", () => {
    const { leaf } = roundTrip({
      "gradient.hero": { type: "radial", stops: ["#4f46e5", "#7c3aed"] },
    });
    expect(leaf).toEqual({
      $value: "radial-gradient(#4f46e5, #7c3aed)",
      $type: "gradient",
    });
  });
});

describe("gradient value-shape guards stay loud (#153, CLAUDE.md §2)", () => {
  it("rejects a flat color sent to a gradient path with a category mismatch", () => {
    expect(() => normalizeTokens({ "gradient.hero": "#4f46e5" })).toThrow(
      /dimension|color|gradient/i,
    );
  });

  it("a structured object with no usable stops falls through to the doc validator", () => {
    const normalized = normalizeTokens({ "gradient.hero": { stops: [] } });
    // Not fabricated into a gradient — the object passes through…
    expect(typeof normalized.set["gradient.hero"]).toBe("object");
    // …and the document validator rejects it loudly.
    const doc = applyDtcgWrites({}, normalized.set, normalized.types);
    expect(() => validateThemeTokens(doc)).toThrow(/gradient/i);
  });
});
