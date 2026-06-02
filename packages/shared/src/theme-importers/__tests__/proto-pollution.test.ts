// SPDX-License-Identifier: MPL-2.0

/**
 * Regression tests for the prototype-pollution guards (issue #113, S5 —
 * js/prototype-polluting-assignment + js/prototype-pollution-utility).
 * Hostile keys derived from imported CSS variable names / dotted write
 * paths must never mutate the prototype chain.
 */

import { describe, expect, it } from "bun:test";
import { isUnsafeKey } from "../../safe-keys.js";
import { applyDtcgWrites } from "../../themes.js";
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
  it("rejects a write whose path contains __proto__ (no pollution, no write)", () => {
    const out = applyDtcgWrites({}, { "a.__proto__.polluted": "x" }, {});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(out).not.toHaveProperty("a");
  });

  it("still applies a legitimate dotted write", () => {
    const out = applyDtcgWrites({}, { "color.primary": "#fff" }, { "color.primary": "color" });
    expect(JSON.stringify(out)).toContain("primary");
  });
});
