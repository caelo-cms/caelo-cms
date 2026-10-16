// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "bun:test";
import {
  axisSpecKey,
  collectPinnedFaces,
  deriveDefaultAxisSpec,
  effectiveAxisSpec,
  expectedOutputAxes,
  FontAxisPolicyError,
  fontAxisPolicy,
  fontWeightDescriptor,
  isFullAxisSpec,
  servedWeightRange,
  validateAxisPolicy,
} from "./font-axis-policy.js";

const INTER = {
  opsz: { min: 14, max: 32, default: 14 },
  wght: { min: 100, max: 900, default: 400 },
};
const TYPICAL = { weights: [400, 700, 900], variationSettingsAxes: [] };

describe("fontAxisPolicy schema", () => {
  it("accepts full, ranges and pins per axis tag", () => {
    expect(fontAxisPolicy.parse({ wght: { min: 400, max: 700 }, opsz: 14, GRAD: "full" })).toEqual({
      wght: { min: 400, max: 700 },
      opsz: 14,
      GRAD: "full",
    });
  });
  it("rejects malformed tags, empty policies and unknown setting shapes", () => {
    expect(fontAxisPolicy.safeParse({ weight: 400 }).success).toBe(false);
    expect(fontAxisPolicy.safeParse({}).success).toBe(false);
    expect(fontAxisPolicy.safeParse({ wght: "half" }).success).toBe(false);
    expect(fontAxisPolicy.safeParse({ wght: { min: 400 } }).success).toBe(false);
    expect(fontAxisPolicy.safeParse({ wght: { min: 1, max: 2, step: 1 } }).success).toBe(false);
  });
});

describe("validateAxisPolicy", () => {
  it("names the face's real axes when an override names one it lacks", () => {
    expect(() => validateAxisPolicy({ wdth: 100 }, INTER, true)).toThrow(
      /no 'wdth' axis; its axes are opsz 14-32, wght 100-900/,
    );
    expect(() => validateAxisPolicy({ wght: 400 }, {}, true)).toThrow(/not a variable font/);
  });
  it("rejects values outside the source range instead of clamping them", () => {
    expect(() => validateAxisPolicy({ wght: { min: 50, max: 700 } }, INTER, true)).toThrow(
      FontAxisPolicyError,
    );
    expect(() => validateAxisPolicy({ opsz: 40 }, INTER, true)).toThrow(
      /outside the face's opsz range 14-32/,
    );
    expect(() => validateAxisPolicy({ wght: { min: 700, max: 400 } }, INTER, true)).toThrow(
      /greater than max/,
    );
  });
  it("only allows full axes on a face whose fsType forbids subsetting", () => {
    expect(() => validateAxisPolicy({ wght: "full" }, INTER, false)).not.toThrow();
    expect(() => validateAxisPolicy({ wght: 400 }, INTER, false)).toThrow(/forbids modifying/);
  });
});

describe("deriveDefaultAxisSpec", () => {
  it("clamps wght to the weights in use and pins every other axis to its default", () => {
    expect(deriveDefaultAxisSpec(INTER, TYPICAL, true)).toEqual({
      opsz: { mode: "pin", value: 14 },
      wght: { mode: "range", min: 400, max: 900 },
    });
  });
  it("keeps wght full when usage is not determinable", () => {
    expect(
      deriveDefaultAxisSpec(INTER, { weights: null, variationSettingsAxes: [] }, true).wght,
    ).toEqual({ mode: "full", min: 100, max: 900 });
  });
  it("intersects usage with the source range and collapses to a pin", () => {
    const narrow = { opsz: INTER.opsz, wght: { min: 300, max: 600, default: 400 } };
    expect(deriveDefaultAxisSpec(narrow, TYPICAL, true).wght).toEqual({
      mode: "range",
      min: 400,
      max: 600,
    });
    expect(
      deriveDefaultAxisSpec(narrow, { weights: [100, 950], variationSettingsAxes: [] }, true).wght,
    ).toEqual({ mode: "full", min: 300, max: 600 });
    expect(
      deriveDefaultAxisSpec(
        { wght: { min: 400, max: 900, default: 400 } },
        { weights: [300, 400], variationSettingsAxes: [] },
        true,
      ).wght,
    ).toEqual({ mode: "pin", value: 400 });
  });
  it("keeps axes addressed by font-variation-settings, and everything when unparsable", () => {
    expect(
      deriveDefaultAxisSpec(INTER, { weights: [400, 700], variationSettingsAxes: ["opsz"] }, true)
        .opsz,
    ).toEqual({ mode: "full", min: 14, max: 32 });
    expect(
      isFullAxisSpec(
        deriveDefaultAxisSpec(INTER, { weights: [400, 700], variationSettingsAxes: "all" }, true),
      ),
    ).toBe(true);
  });
  it("keeps a no-subsetting face whole", () => {
    expect(isFullAxisSpec(deriveDefaultAxisSpec(INTER, TYPICAL, false))).toBe(true);
  });
});

describe("effectiveAxisSpec", () => {
  it("lets the override win per axis and reports the origin", () => {
    const { spec, origin } = effectiveAxisSpec(INTER, { opsz: "full" }, TYPICAL, true);
    expect(spec).toEqual({
      opsz: { mode: "full", min: 14, max: 32 },
      wght: { mode: "range", min: 400, max: 900 },
    });
    expect(origin).toEqual({ opsz: "override", wght: "default" });
  });
  it("normalizes a full-width range to full and a zero-width range to a pin", () => {
    const { spec } = effectiveAxisSpec(
      INTER,
      { wght: { min: 100, max: 900 }, opsz: { min: 20, max: 20 } },
      TYPICAL,
      true,
    );
    expect(spec).toEqual({
      opsz: { mode: "pin", value: 20 },
      wght: { mode: "full", min: 100, max: 900 },
    });
  });
  it("throws for an override that does not fit the face", () => {
    expect(() => effectiveAxisSpec(INTER, { wght: 1000 }, TYPICAL, true)).toThrow(
      FontAxisPolicyError,
    );
  });
});

describe("spec helpers", () => {
  const spec = deriveDefaultAxisSpec(INTER, TYPICAL, true);
  it("keys a spec canonically (cache key input)", () => {
    expect(axisSpecKey(spec)).toBe("opsz=14;wght=400..900");
    expect(axisSpecKey({ wght: spec.wght!, opsz: spec.opsz! })).toBe(axisSpecKey(spec));
    expect(axisSpecKey(effectiveAxisSpec(INTER, { opsz: "full" }, TYPICAL, true).spec)).not.toBe(
      axisSpecKey(spec),
    );
  });
  it("expects pinned axes to disappear from the delivered file", () => {
    expect(expectedOutputAxes(spec)).toEqual({ wght: { min: 400, max: 900 } });
  });
  it("derives the @font-face weight descriptor from the delivered range", () => {
    expect(fontWeightDescriptor(spec, 400)).toBe("400 900");
    expect(fontWeightDescriptor({ wght: { mode: "pin", value: 500 } }, 400)).toBe("500");
    expect(fontWeightDescriptor({}, 300)).toBe("300");
    expect(servedWeightRange(spec, 400)).toEqual([400, 900]);
    expect(servedWeightRange({}, 300)).toEqual([300, 300]);
  });
});

describe("collectPinnedFaces", () => {
  const ref = { id: "0b1f6c2e-9d7a-4c1e-8f3a-2b6d9e0c1a4f", sha256: "a".repeat(64) };
  const role = (axes?: unknown, weight = 400) => ({
    $type: "typography",
    $value: { fontFamily: "Inter", fontWeight: weight },
    $extensions: { "caelo.font": ref, ...(axes === undefined ? {} : { "caelo.fontAxes": axes }) },
  });
  it("groups roles by face and carries the shared override", () => {
    const faces = collectPinnedFaces({
      typography: { body: role({ opsz: "full" }), heading: role({ opsz: "full" }, 700), mono: {} },
    });
    expect(faces).toHaveLength(1);
    expect(faces[0]?.roles.map((r) => r.role)).toEqual(["body", "heading"]);
    expect(faces[0]?.override).toEqual({ opsz: "full" });
  });
  it("fails loudly when roles of one face disagree or an override is malformed", () => {
    expect(() =>
      collectPinnedFaces({ typography: { body: role({ opsz: "full" }), heading: role() } }),
    ).toThrow(/different axis overrides/);
    expect(() => collectPinnedFaces({ typography: { body: role({ wght: "half" }) } })).toThrow(
      /malformed caelo.fontAxes/,
    );
  });
});
