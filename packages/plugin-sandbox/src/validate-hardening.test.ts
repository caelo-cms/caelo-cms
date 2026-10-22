// SPDX-License-Identifier: MPL-2.0

import { describe, expect, test } from "bun:test";
import { validateSource } from "./validate.js";

describe("validateSource AST hardening", () => {
  test("rejects ObjectPattern destructuring of constructor and computed constructor", () => {
    const direct = validateSource({
      filename: "plugin.ts",
      source: "const { constructor: F } = () => {}; F('return 1')();",
    });
    expect(direct.some((f) => f.kind === "forbidden-eval")).toBe(true);

    const shorthand = validateSource({
      filename: "plugin.ts",
      source: "const { constructor } = () => {}; constructor('return 1')();",
    });
    expect(shorthand.some((f) => f.kind === "forbidden-eval")).toBe(true);

    const computed = validateSource({
      filename: "plugin.ts",
      source: 'const { ["con" + "structor"]: F } = () => {}; F("return 1")();',
    });
    expect(computed.some((f) => f.kind === "forbidden-eval")).toBe(true);
  });

  test("rejects ObjectPattern destructuring of forbidden globals (eval, Function, Deno, fetch, require)", () => {
    for (const [pattern, expectedKind] of [
      ["const { eval: e } = obj;", "forbidden-eval"],
      ["const { Function: Fn } = obj;", "forbidden-eval"],
      ["const { Deno: d } = obj;", "forbidden-deno-access"],
      ["const { fetch: f } = obj;", "forbidden-call"],
      ["const { require: r } = obj;", "forbidden-require"],
      ["const { globalThis: g } = obj;", "forbidden-globalthis-alias"],
    ] as const) {
      const failures = validateSource({ filename: "plugin.ts", source: pattern });
      expect(failures.some((f) => f.kind === expectedKind)).toBe(true);
    }
  });
});
