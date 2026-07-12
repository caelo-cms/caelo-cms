// SPDX-License-Identifier: MPL-2.0
/**
 * issue #242 (F11) — normalizeTokens accepts BOTH the DTCG envelope
 * (`{$type, $value}`) and the raw `$value` form for composite values,
 * plus JSON-encoded object strings. Garbage still fails downstream
 * validation — this layer only repairs encoding, never content.
 */
import { describe, expect, it } from "bun:test";
import { normalizeTokens } from "./theme-normalize.js";

describe("normalizeTokens envelope tolerance (#242)", () => {
  const typographyValue = { fontFamily: "Inter, sans-serif", fontSize: "1rem", fontWeight: 600 };

  it("accepts the raw composite $value object", () => {
    const r = normalizeTokens({ "typography.body": typographyValue });
    expect(r.set["typography.body"]).toEqual(typographyValue);
  });

  it("unwraps the full DTCG envelope to its $value", () => {
    const r = normalizeTokens({
      "typography.body": { $type: "typography", $value: typographyValue },
    });
    expect(r.set["typography.body"]).toEqual(typographyValue);
  });

  it("parses a JSON-encoded composite string, then unwraps", () => {
    const r = normalizeTokens({
      "typography.body": JSON.stringify({ $type: "typography", $value: typographyValue }),
    });
    expect(r.set["typography.body"]).toEqual(typographyValue);
  });

  it("keeps plain scalar values untouched", () => {
    const r = normalizeTokens({ "color.primary": "#7c2d12" });
    expect(r.set["color.primary"]).toBe("#7c2d12");
  });

  it("still rejects garbage loudly — encoding repair never validates content", () => {
    expect(() => normalizeTokens({ "color.primary": "{not json" })).toThrow(
      /not a recognised CSS color/,
    );
  });
});
