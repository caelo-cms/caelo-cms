// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { type CssToken, cssTokens } from "./css-tokens.js";

const kinds = (css: string) =>
  cssTokens(css)
    .filter((t) => t.kind !== "ws")
    .map((t: CssToken) => {
      switch (t.kind) {
        case "ident":
          return `ident:${t.value}`;
        case "function":
          return `fn:${t.name}`;
        case "at":
          return `at:${t.name}`;
        case "string":
          return `str:${t.value}`;
        case "url":
          return `${t.bad ? "badurl" : "url"}:${t.value}`;
        case "number":
          return "num";
        case "delim":
          return t.value;
        default:
          return t.kind;
      }
    });

describe("cssTokens (#1729, CSS Syntax 3 §4)", () => {
  it("drops closed comments between tokens and reads an unclosed one as CSS", () => {
    expect(kinds("a/* x */b")).toEqual(["ident:a", "ident:b"]);
    expect(kinds("u/**/rl(x)")).toEqual(["ident:u", "fn:rl", "ident:x", ")"]);
    expect(kinds("/*/ x */y")).toEqual(["ident:y"]);
    expect(kinds("a{}/* @import")).toEqual(["ident:a", "{", "}", "/", "*", "at:import"]);
  });

  it("reads strings with their escapes, and a comment inside one is text", () => {
    expect(kinds(`"/*" '*/'`)).toEqual(["str:/*", "str:*/"]);
    expect(
      kinds(String.raw`"a\"b" 'c\
d'`),
    ).toEqual(['str:a"b', "str:cd"]);
    expect(kinds(String.raw`"\\e" "\41 B" "\110000"`)).toEqual(["str:\\e", "str:AB", "str:�"]);
    // A newline ends a bad string; reading goes on after it.
    expect(kinds(`"ab\ncd`)).toEqual(["str:ab", "ident:cd"]);
  });

  it("reads names, functions, at-keywords and url tokens with escapes decoded", () => {
    expect(kinds(String.raw`\75 rl(/a) @\69mport URL( "x" ) -moz-binding`)).toEqual([
      "url:/a",
      "at:import",
      "fn:URL",
      "str:x",
      ")",
      "ident:-moz-binding",
    ]);
    expect(
      kinds(String.raw`url( /a\)b ) url(a b) url(a"b) url(\
)`),
    ).toEqual(["url:/a)b", "badurl:a", "badurl:a", "badurl:"]);
  });

  it("reads numbers and dimensions as one token", () => {
    expect(kinds("1px -2.5e3em 10% 1url(x)")).toEqual([
      "num",
      "num",
      "num",
      "num",
      "(",
      "ident:x",
      ")",
    ]);
  });

  it("runs in linear time on a stylesheet of unclosed comments", () => {
    const started = performance.now();
    cssTokens(`/*${"a/*".repeat(200_000)}`);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
