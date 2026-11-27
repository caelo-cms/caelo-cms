// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — a list-resolve answer's parts merge per variant and address. A
 * variant token or an address is any string a plugin names: one spelled
 * like an Object property (`constructor`, `toString`, `__proto__`) is a
 * key like any other.
 */

import { describe, expect, it } from "bun:test";
import { mergeOverlayPart, type OverlayAccumulator, overlaysRecord } from "./list-resolve.js";

describe("mergeOverlayPart (#1729)", () => {
  it("keys variants and addresses that read like Object properties as their own", () => {
    const into: OverlayAccumulator = new Map();
    const asked = new Set(["constructor", "toString", "de"]);
    // As an answer arrives: parsed JSON, where `__proto__` is an own key.
    const part = JSON.parse(
      '{"constructor":{"values":{},"hidden":[]},"toString":{"values":{"a/x":1},"hidden":["b"]},"de":{"values":{"__proto__":"v"},"hidden":[]}}',
    );
    mergeOverlayPart(into, part, asked, "probe");
    mergeOverlayPart(into, { toString: { values: { "a/x": 1 }, hidden: ["c"] } }, asked, "probe");
    const record = overlaysRecord(into);
    expect(record.constructor).toEqual({ values: {}, hidden: [] });
    expect(record.toString).toEqual({ values: { "a/x": 1 }, hidden: ["b", "c"] });
    expect(Object.hasOwn(record.de?.values ?? {}, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(record.de?.values)).toBe(Object.prototype);
  });

  it("refuses a variant not asked about and an address two parts disagree on", () => {
    const into: OverlayAccumulator = new Map();
    expect(() =>
      mergeOverlayPart(into, { fr: { values: {}, hidden: [] } }, new Set(["de"]), "probe"),
    ).toThrow('answered for variant "fr"');
    mergeOverlayPart(into, { de: { values: { a: 1 }, hidden: [] } }, new Set(["de"]), "probe");
    expect(() =>
      mergeOverlayPart(into, { de: { values: { a: 2 }, hidden: [] } }, new Set(["de"]), "probe"),
    ).toThrow('"a" in variant de has two different values');
  });
});
