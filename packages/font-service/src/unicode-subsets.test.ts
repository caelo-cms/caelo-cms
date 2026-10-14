// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "bun:test";
import { formatUnicodeRange, parseUnicodeRange, planSlices } from "./unicode-subsets.js";

test("parses and formats CSS unicode-range values", () => {
  expect(parseUnicodeRange("U+0000-00FF, U+0131")).toEqual([
    [0, 0xff],
    [0x131, 0x131],
  ]);
  expect(() => parseUnicodeRange("U+4??")).toThrow("UnicodeRangeInvalid");
  expect(formatUnicodeRange([0x41, 0x42, 0x43, 0x2192, 0x1f600])).toBe(
    "U+0041-0043, U+2192, U+1F600",
  );
});

test("a slice needs a code point of its own; shared code points are never lost", () => {
  // U+0301 is listed under cyrillic AND vietnamese; U+0304 under latin,
  // latin-ext and vietnamese. Neither alone justifies a slice.
  expect(planSlices([0x41, 0x301, 0x304]).map((s) => s.name)).toEqual(["vietnamese", "latin"]);
  // A code point no emitted slice carries re-admits ONE slice for it.
  expect(planSlices([0x301]).map((s) => s.name)).toEqual(["vietnamese"]);
  expect(planSlices([0x2116]).map((s) => s.name)).toEqual(["cyrillic"]);
  expect(planSlices([0x41, 0x414, 0x2603]).map((s) => [s.name, s.codePoints])).toEqual([
    ["other", [0x2603]],
    ["cyrillic", [0x414]],
    ["latin", [0x41]],
  ]);
});
