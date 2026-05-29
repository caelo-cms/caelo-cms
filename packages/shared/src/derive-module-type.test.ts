// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.3 (issue #106) — unit guards for the module type/slug helpers.
 * The load-bearing invariant: a module's stable `type` is the slug base
 * WITHOUT the uniqueness suffix, so `type` is always a prefix of `slug`
 * and the two can never drift (which is what the allowedModuleTypes match
 * relies on).
 */

import { describe, expect, it } from "bun:test";
import { deriveModuleType, slugifyModuleName, slugifyModuleSection } from "./content.js";

describe("deriveModuleType", () => {
  it("lowercases + hyphenates and drops no suffix", () => {
    expect(deriveModuleType("Primary Button")).toBe("primary-button");
  });

  it("collapses runs of non-alphanumerics to a single hyphen, trimmed", () => {
    expect(deriveModuleType("CTA!!  banner $$$")).toBe("cta-banner");
  });

  it("falls back to 'module' for empty / all-punctuation names", () => {
    expect(deriveModuleType("!!!")).toBe("module");
    expect(deriveModuleType("")).toBe("module");
  });

  it("caps the base at 40 chars", () => {
    expect(deriveModuleType("a".repeat(80)).length).toBe(40);
  });

  it("produces NO -<timestamp> suffix (contrast with slugifyModuleName)", () => {
    const t = deriveModuleType("Button");
    expect(t).toBe("button");
    expect(t).not.toMatch(/-[a-z0-9]+$/);
  });
});

describe("slugifyModuleName", () => {
  it("composes as deriveModuleType + '-' + suffix (type is a slug prefix)", () => {
    expect(slugifyModuleName("Primary Button", "abc123")).toBe("primary-button-abc123");
    const name = "Hero Banner";
    expect(slugifyModuleName(name, "x").startsWith(`${deriveModuleType(name)}-`)).toBe(true);
  });

  it("uses a base36 timestamp suffix when none is given", () => {
    expect(slugifyModuleName("Button")).toMatch(/^button-[a-z0-9]+$/);
  });
});

describe("slugifyModuleSection", () => {
  it("inserts the section index between the type base and the suffix", () => {
    expect(slugifyModuleSection("Hero", 2, "zzz")).toBe("hero-2-zzz");
  });

  it("keeps the type base as a prefix so same-named sections don't collide", () => {
    const a = slugifyModuleSection("Card", 0, "s");
    const b = slugifyModuleSection("Card", 1, "s");
    expect(a).not.toBe(b);
    expect(a.startsWith("card-")).toBe(true);
    expect(b.startsWith("card-")).toBe(true);
  });
});
