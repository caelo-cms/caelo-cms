// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { computeContentHash, isHomeSlug, pageIsLocaleHome } from "./i18n.js";

describe("isHomeSlug", () => {
  it("recognises the magic-slug sentinels regardless of surrounding slashes", () => {
    for (const s of ["", "home", "index", "/", "/home/", "/index"]) {
      expect(isHomeSlug(s)).toBe(true);
    }
  });

  it("treats any other slug as non-home", () => {
    for (const s of ["about", "en", "blog/post", "homepage"]) {
      expect(isHomeSlug(s)).toBe(false);
    }
  });
});

describe("pageIsLocaleHome (0184 shared predicate)", () => {
  const PAGE = "11111111-1111-4111-8111-111111111111";
  const OTHER = "22222222-2222-4222-8222-222222222222";

  it("is true when the page IS the locale's designated home_page_id", () => {
    expect(pageIsLocaleHome(PAGE, "en", PAGE)).toBe(true);
  });

  it("is true for a magic slug even with no designation", () => {
    expect(pageIsLocaleHome(PAGE, "home", null)).toBe(true);
    expect(pageIsLocaleHome(PAGE, "index", undefined)).toBe(true);
  });

  it("is false for a non-magic slug that isn't the designated page", () => {
    expect(pageIsLocaleHome(PAGE, "en", OTHER)).toBe(false);
    expect(pageIsLocaleHome(PAGE, "about", null)).toBe(false);
  });
});

describe("computeContentHash", () => {
  it("is stable across runs for the same input", async () => {
    const a = await computeContentHash({ x: 1, y: [1, 2] });
    const b = await computeContentHash({ x: 1, y: [1, 2] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is order-independent for object keys", async () => {
    const a = await computeContentHash({ x: 1, y: 2 });
    const b = await computeContentHash({ y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it("is order-dependent for arrays", async () => {
    const a = await computeContentHash({ x: [1, 2] });
    const b = await computeContentHash({ x: [2, 1] });
    expect(a).not.toBe(b);
  });
});

