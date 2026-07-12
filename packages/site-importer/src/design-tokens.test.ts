// SPDX-License-Identifier: MPL-2.0

/**
 * issue #247 (WS1) — unit coverage for the pure computed-style →
 * design-token pipeline: color normalisation, frequency ordering,
 * determinism, caps, site aggregation, and the compose flattening.
 */

import { describe, expect, it } from "bun:test";
import {
  aggregateSiteDesignTokens,
  deriveDesignTokens,
  type ElementStyleSample,
  flattenSiteDesignTokens,
  normalizeColor,
} from "./design-tokens.js";

const sample = (
  role: ElementStyleSample["role"],
  styles: Record<string, string>,
): ElementStyleSample => ({ role, styles });

describe("normalizeColor", () => {
  it("normalises rgb()/rgba()/short-hex to lowercase hex", () => {
    expect(normalizeColor("rgb(255, 0, 0)")).toBe("#ff0000");
    expect(normalizeColor("rgba(0, 128, 255, 0.5)")).toBe("#0080ff80");
    expect(normalizeColor("#ABC")).toBe("#aabbcc");
    expect(normalizeColor("#AABBCC")).toBe("#aabbcc");
    expect(normalizeColor("rgb(1 2 3 / 50%)")).toBe("#01020380");
  });

  it("drops transparent and unparseable values", () => {
    expect(normalizeColor("rgba(0, 0, 0, 0)")).toBeNull();
    expect(normalizeColor("transparent")).toBeNull();
    expect(normalizeColor("")).toBeNull();
    expect(normalizeColor("var(--brand)")).toBeNull();
    expect(normalizeColor("rgb(999, 0, 0)")).toBeNull();
  });

  it("treats near-full alpha as opaque", () => {
    expect(normalizeColor("rgba(10, 20, 30, 0.999)")).toBe("#0a141e");
  });
});

describe("deriveDesignTokens", () => {
  it("builds a deduped, frequency-ordered palette across text + background colors", () => {
    const tokens = deriveDesignTokens([
      sample("body", { color: "rgb(17, 17, 17)", backgroundColor: "rgb(255, 255, 255)" }),
      sample("p", { color: "rgb(17, 17, 17)" }),
      sample("p", { color: "rgb(17, 17, 17)" }),
      sample("a", { color: "rgb(0, 102, 204)" }),
    ]);
    expect(tokens.palette).toEqual([
      { value: "#111111", count: 3 },
      { value: "#0066cc", count: 1 },
      { value: "#ffffff", count: 1 },
    ]);
    expect(tokens.backgrounds).toEqual([{ value: "#ffffff", count: 1 }]);
  });

  it("is deterministic on ties (value ascending) and independent of input order", () => {
    const a = deriveDesignTokens([
      sample("p", { color: "rgb(1, 1, 1)" }),
      sample("p", { color: "rgb(2, 2, 2)" }),
    ]);
    const b = deriveDesignTokens([
      sample("p", { color: "rgb(2, 2, 2)" }),
      sample("p", { color: "rgb(1, 1, 1)" }),
    ]);
    expect(a.palette).toEqual(b.palette);
    expect(a.palette[0]?.value).toBe("#010101");
  });

  it("keeps the FIRST sample per role and normalises its colors", () => {
    const tokens = deriveDesignTokens([
      sample("button", {
        color: "rgb(255, 255, 255)",
        backgroundColor: "rgb(220, 38, 38)",
        borderRadius: "8px",
        boxShadow: "none",
      }),
      sample("button", { color: "rgb(0, 0, 0)", backgroundColor: "rgb(1, 2, 3)" }),
    ]);
    expect(tokens.roles.button).toEqual({
      color: "#ffffff",
      backgroundColor: "#dc2626",
      borderRadius: "8px",
    });
  });

  it("filters zero radii and none shadows, keeps real ones", () => {
    const tokens = deriveDesignTokens([
      sample("button", { borderRadius: "0px", boxShadow: "none" }),
      sample("button", { borderRadius: "6px", boxShadow: "rgba(0, 0, 0, 0.1) 0px 1px 2px 0px" }),
    ]);
    expect(tokens.radii).toEqual([{ value: "6px", count: 1 }]);
    expect(tokens.shadows).toEqual([{ value: "rgba(0, 0, 0, 0.1) 0px 1px 2px 0px", count: 1 }]);
  });

  it("caps every list so the JSON stays small", () => {
    const many: ElementStyleSample[] = [];
    for (let i = 0; i < 40; i++) {
      many.push(sample("p", { color: `rgb(${i}, ${i}, ${i})`, fontSize: `${10 + i}px` }));
    }
    const tokens = deriveDesignTokens(many);
    expect(tokens.palette.length).toBeLessThanOrEqual(12);
    expect(tokens.fontSizes.length).toBeLessThanOrEqual(10);
    // A realistic full sample set must stay well under a few KB.
    expect(JSON.stringify(tokens).length).toBeLessThan(4096);
  });

  it("returns empty lists for no samples (loud upstream, not a crash here)", () => {
    const tokens = deriveDesignTokens([]);
    expect(tokens.palette).toEqual([]);
    expect(Object.keys(tokens.roles)).toEqual([]);
  });
});

describe("aggregateSiteDesignTokens", () => {
  const pageA = deriveDesignTokens([
    sample("body", {
      color: "rgb(17, 17, 17)",
      backgroundColor: "rgb(255, 255, 255)",
      fontFamily: "Inter, sans-serif",
    }),
    sample("a", { color: "rgb(0, 102, 204)" }),
  ]);
  const pageB = deriveDesignTokens([
    sample("body", {
      color: "rgb(17, 17, 17)",
      backgroundColor: "rgb(250, 250, 250)",
      fontFamily: "Inter, sans-serif",
    }),
    sample("a", { color: "rgb(0, 102, 204)" }),
  ]);
  const pageC = deriveDesignTokens([
    sample("body", {
      color: "rgb(17, 17, 17)",
      backgroundColor: "rgb(255, 255, 255)",
      fontFamily: "Inter, sans-serif",
    }),
  ]);

  it("sums frequencies and resolves role properties by majority vote", () => {
    const site = aggregateSiteDesignTokens([pageA, pageB, pageC]);
    expect(site.pageCount).toBe(3);
    // #ffffff appears on 2 pages, #fafafa on 1 → majority wins.
    expect(site.roles.body?.backgroundColor).toBe("#ffffff");
    expect(site.roles.body?.fontFamily).toBe("Inter, sans-serif");
    expect(site.palette[0]).toEqual({ value: "#111111", count: 3 });
  });

  it("is deterministic regardless of page order", () => {
    const x = aggregateSiteDesignTokens([pageA, pageB, pageC]);
    const y = aggregateSiteDesignTokens([pageC, pageB, pageA]);
    expect(JSON.stringify(x)).toBe(JSON.stringify(y));
  });
});

describe("flattenSiteDesignTokens", () => {
  it("maps role properties to the compose token names with scopes", () => {
    const site = aggregateSiteDesignTokens([
      deriveDesignTokens([
        sample("body", {
          color: "rgb(17, 17, 17)",
          backgroundColor: "rgb(255, 255, 255)",
          fontFamily: "Inter, sans-serif",
        }),
        sample("h1", { color: "rgb(0, 0, 0)", fontFamily: "Sora, sans-serif" }),
        sample("a", { color: "rgb(0, 102, 204)" }),
        sample("button", {
          color: "rgb(255, 255, 255)",
          backgroundColor: "rgb(220, 38, 38)",
          borderRadius: "8px",
        }),
      ]),
    ]);
    expect(flattenSiteDesignTokens(site)).toEqual([
      { token: "color-background", value: "#ffffff", scope: "color" },
      { token: "color-text", value: "#111111", scope: "color" },
      { token: "color-heading", value: "#000000", scope: "color" },
      { token: "color-link", value: "#0066cc", scope: "color" },
      { token: "color-primary", value: "#dc2626", scope: "color" },
      { token: "color-primary-contrast", value: "#ffffff", scope: "color" },
      { token: "font-family", value: "Inter, sans-serif", scope: "font" },
      { token: "font-heading", value: "Sora, sans-serif", scope: "font" },
      { token: "radius-base", value: "8px", scope: "radius" },
    ]);
  });

  it("emits nothing for roles that were never sampled", () => {
    const site = aggregateSiteDesignTokens([]);
    expect(flattenSiteDesignTokens(site)).toEqual([]);
  });
});
