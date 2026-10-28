// SPDX-License-Identifier: MPL-2.0

/**
 * Regression tests for the prototype-pollution guards (issue #113, S5 —
 * js/prototype-polluting-assignment + js/prototype-pollution-utility).
 * Hostile keys derived from imported CSS variable names / dotted write
 * paths must never mutate the prototype chain.
 */

import { describe, expect, it } from "bun:test";
import { isUnsafeKey } from "../../safe-keys.js";
import { applyDtcgWrites, removeDtcgPath } from "../../themes.js";
import { UnknownTokenName } from "../../themes-errors.js";
import { importTailwind } from "../tailwind.js";

describe("isUnsafeKey", () => {
  it("flags the prototype-pollution keys and nothing else", () => {
    expect(isUnsafeKey("__proto__")).toBe(true);
    expect(isUnsafeKey("constructor")).toBe(true);
    expect(isUnsafeKey("prototype")).toBe(true);
    expect(isUnsafeKey("primary")).toBe(false);
    expect(isUnsafeKey("color")).toBe(false);
  });
});

describe("importTailwind prototype-pollution guard (S5)", () => {
  it("drops a hostile --color-__proto__ token without polluting", () => {
    const doc = importTailwind("@theme { --color-__proto__: #ff6600; --color-primary: #112233; }");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("__proto__polluted");
    // The legitimate token still imports.
    expect(JSON.stringify(doc)).toContain("primary");
  });

  it("drops a hostile ramp base name (--color-constructor-500)", () => {
    const doc = importTailwind(
      "@theme { --color-constructor-500: #abcabc; --color-primary: #001122; }",
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.stringify(doc)).toContain("primary");
  });
});

describe("applyDtcgWrites / setLeafAtPath path guard (S5)", () => {
  it("refuses a write whose path contains __proto__, naming the path (no pollution)", () => {
    expect(() => applyDtcgWrites({}, { "a.__proto__.polluted": "x" }, {})).toThrow(
      /UnknownTokenName: cannot infer canonical path for 'a\.__proto__\.polluted'/,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses constructor/prototype segments, including as the leaf", () => {
    expect(() => applyDtcgWrites({}, { "color.constructor": "#fff" }, {})).toThrow(
      UnknownTokenName,
    );
    expect(() => applyDtcgWrites({}, { "prototype.x": "#fff" }, {})).toThrow(UnknownTokenName);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("still applies a legitimate dotted write", () => {
    const out = applyDtcgWrites({}, { "color.primary": "#fff" }, { "color.primary": "color" });
    expect(JSON.stringify(out)).toContain("primary");
  });

  it("removeDtcgPath rejects __proto__/constructor/prototype and inherited keys", () => {
    const doc = applyDtcgWrites({}, { "color.primary": "#fff" }, { "color.primary": "color" });
    expect(removeDtcgPath(doc, "__proto__.toString").removed).toBe(false);
    expect(removeDtcgPath(doc, "color.toString").removed).toBe(false);
    expect(removeDtcgPath(doc, "constructor.prototype").removed).toBe(false);
    expect(removeDtcgPath(doc, "color.primary").removed).toBe(true);
  });
});
