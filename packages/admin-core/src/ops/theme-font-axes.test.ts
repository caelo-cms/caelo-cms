// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "bun:test";
import { overrideForNewBinding, overrideWeightConflict } from "./theme-font-axes.js";

const A = { id: "0b1f6c2e-9d7a-4c1e-8f3a-2b6d9e0c1a4f", sha256: "a".repeat(64) };
const B = { id: "1b1f6c2e-9d7a-4c1e-8f3a-2b6d9e0c1a4f", sha256: "b".repeat(64) };

function role(ref: typeof A, axes?: unknown, fontWeight: unknown = 400) {
  return {
    $type: "typography",
    $value: { fontFamily: "Inter", fontWeight },
    $extensions: { "caelo.font": ref, ...(axes === undefined ? {} : { "caelo.fontAxes": axes }) },
  };
}

describe("overrideForNewBinding", () => {
  it("inherits the override another role of the same face carries", () => {
    const typography = { body: role(A, { opsz: "full" }), heading: role(B) };
    expect(overrideForNewBinding(typography, "heading", A.sha256, typography.heading)).toEqual({
      opsz: "full",
    });
  });
  it("keeps the role's own override when re-bound to the same face, drops it for another face", () => {
    const previous = role(A, { opsz: 20 });
    expect(overrideForNewBinding({ body: previous }, "body", A.sha256, previous)).toEqual({
      opsz: 20,
    });
    expect(overrideForNewBinding({ body: previous }, "body", B.sha256, previous)).toBeUndefined();
  });
});

describe("overrideWeightConflict", () => {
  it("names the role whose weight the override excludes", () => {
    expect(
      overrideWeightConflict({ heading: role(A, { wght: { min: 400, max: 700 } }, 800) }),
    ).toMatch(/^typography\.heading uses weight 800, outside the wght range 400-700/);
    expect(overrideWeightConflict({ body: role(A, { wght: 500 }, "bold") })).toMatch(
      /weight 700, outside the wght pin 500/,
    );
  });
  it("accepts weights inside the range, full wght and roles without an override", () => {
    expect(
      overrideWeightConflict({
        body: role(A, { wght: { min: 400, max: 700 } }, 700),
        heading: role(B, { wght: "full" }, 900),
        mono: role(B, undefined, 300),
        plain: { $value: { fontWeight: 100 } },
      }),
    ).toBeNull();
  });
});
