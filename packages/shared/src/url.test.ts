// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { isDesignatedHomePage, isHomeSlug } from "./url.js";

describe("isHomeSlug", () => {
  it("recognises the magic-slug sentinels regardless of surrounding slashes", () => {
    for (const s of ["", "home", "index", "/", "/home/", "/index"]) {
      expect(isHomeSlug(s)).toBe(true);
    }
  });

  it("rejects ordinary slugs", () => {
    for (const s of ["about", "homepage", "index2", "blog/home"]) {
      expect(isHomeSlug(s)).toBe(false);
    }
  });
});

describe("isDesignatedHomePage (0184 shared predicate)", () => {
  const PAGE = "11111111-1111-1111-1111-111111111111";
  const OTHER = "22222222-2222-2222-2222-222222222222";

  it("explicit designation wins regardless of slug", () => {
    expect(isDesignatedHomePage(PAGE, "welcome", PAGE)).toBe(true);
  });

  it("magic slug is the fallback when no designation exists", () => {
    expect(isDesignatedHomePage(PAGE, "home", null)).toBe(true);
    expect(isDesignatedHomePage(PAGE, "home", undefined)).toBe(true);
  });

  it("a designation pointing at ANOTHER page does not claim this one", () => {
    expect(isDesignatedHomePage(PAGE, "welcome", OTHER)).toBe(false);
  });

  it("plain page, no designation: not home", () => {
    expect(isDesignatedHomePage(PAGE, "about", null)).toBe(false);
  });
});
