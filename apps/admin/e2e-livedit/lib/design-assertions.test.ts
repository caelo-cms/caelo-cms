// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  checkColorVariety,
  checkTypeHierarchy,
  checkWebFontsDelivered,
  compareStyleSnapshots,
  distinctChromaticColors,
  findTemplateLeaks,
  isNeutral,
  median,
  parseComputedColor,
  pickPrimaryCta,
  primaryFamily,
} from "./design-assertions.js";

describe("parseComputedColor", () => {
  it("reads legacy rgb/rgba in comma and space syntax", () => {
    expect(parseComputedColor("rgb(37, 99, 235)")).toEqual({ r: 37, g: 99, b: 235, a: 1 });
    expect(parseComputedColor("rgba(0, 0, 0, 0)").a).toBe(0);
    expect(parseComputedColor("rgb(10 20 30 / 0.5)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
  });

  it("converts oklch to sRGB (white, black, a chromatic blue)", () => {
    const white = parseComputedColor("oklch(1 0 0)");
    expect(white.r).toBeGreaterThanOrEqual(254);
    expect(white.b).toBeGreaterThanOrEqual(254);
    const black = parseComputedColor("oklch(0 0 0)");
    expect(black.r + black.g + black.b).toBe(0);
    const blue = parseComputedColor("oklch(0.55 0.2 260)");
    expect(blue.b).toBeGreaterThan(blue.r);
    expect(isNeutral(blue)).toBe(false);
    expect(parseComputedColor("oklch(60% 0.1 200 / 0.4)").a).toBeCloseTo(0.4);
  });

  it("converts lab / lch / color() spaces", () => {
    const red = parseComputedColor("lab(54.29 80.8 69.89)");
    expect(red.r).toBeGreaterThan(240);
    expect(red.g).toBeLessThan(30);
    const gray = parseComputedColor("lch(50 0 0)");
    expect(isNeutral(gray)).toBe(true);
    expect(parseComputedColor("color(srgb 1 0 0)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseComputedColor("color(display-p3 0 0.5 1 / 0.5)").a).toBe(0.5);
  });

  it("throws on unknown formats instead of dropping the color", () => {
    expect(() => parseComputedColor("currentcolor")).toThrow(/unrecognised/);
    expect(() => parseComputedColor("hwb(0 0% 0%)")).toThrow(/unsupported color function/);
    expect(() => parseComputedColor("color(xyz 1 1 1)")).toThrow(/unsupported color\(\) space/);
  });
});

describe("distinctChromaticColors", () => {
  it("skips neutrals and transparent, merges near shades", () => {
    const out = distinctChromaticColors([
      "rgb(255, 255, 255)",
      "rgb(17, 17, 17)",
      "rgba(37, 99, 235, 0)",
      "rgb(37, 99, 235)",
      "rgb(40, 102, 238)", // hover shade of the primary
      "rgb(249, 115, 22)", // accent
    ]);
    expect(out.length).toBe(2);
  });
});

describe("distinctChromaticColors — unstyled links", () => {
  it("does not count the browser's default link colors as palette use", () => {
    expect(distinctChromaticColors(["rgb(0, 0, 238)", "rgb(85, 26, 139)"])).toEqual([]);
  });
});

describe("checkColorVariety", () => {
  const sections = [
    { label: "header", backgroundColor: "rgb(255, 255, 255)", backgroundImage: "none" },
    { label: "section:nth(1)", backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none" },
  ];

  it("passes a page with two hues and one tinted section", () => {
    expect(
      checkColorVariety({
        pageBackground: "rgb(255, 255, 255)",
        usedColors: ["rgb(37, 99, 235)", "rgb(249, 115, 22)"],
        sections: [
          ...sections,
          { label: "footer", backgroundColor: "rgb(15, 23, 42)", backgroundImage: "none" },
        ],
      }),
    ).toEqual([]);
  });

  it("accepts a gradient section as differing from the page", () => {
    expect(
      checkColorVariety({
        pageBackground: "rgb(255, 255, 255)",
        usedColors: ["rgb(37, 99, 235)", "rgb(249, 115, 22)"],
        sections: [
          ...sections,
          {
            label: "hero",
            backgroundColor: "rgba(0, 0, 0, 0)",
            backgroundImage: "linear-gradient(rgb(37, 99, 235), rgb(17, 24, 39))",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("flags a monochrome page with flat sections", () => {
    const v = checkColorVariety({
      pageBackground: "rgb(255, 255, 255)",
      usedColors: ["rgb(17, 17, 17)", "rgb(37, 99, 235)"],
      sections,
    });
    expect(v.length).toBe(2);
    expect(v[0]).toContain("1 distinct chromatic");
    expect(v[1]).toContain("no section rhythm");
  });

  it("flags a probe that found no sections", () => {
    const v = checkColorVariety({
      pageBackground: "rgb(255, 255, 255)",
      usedColors: ["rgb(37, 99, 235)", "rgb(249, 115, 22)"],
      sections: [],
    });
    expect(v[0]).toContain("no top-level sections");
  });
});

describe("checkTypeHierarchy", () => {
  it("passes a real scale", () => {
    expect(
      checkTypeHierarchy({ h1Px: [56], h2Px: [36, 32, 36], paragraphPx: [16, 18, 16] }),
    ).toEqual([]);
  });

  it("passes a page without h2", () => {
    expect(checkTypeHierarchy({ h1Px: [40], h2Px: [], paragraphPx: [16] })).toEqual([]);
  });

  it("tolerates one oversized h2 via the median", () => {
    expect(checkTypeHierarchy({ h1Px: [56], h2Px: [32, 32, 64], paragraphPx: [16] })).toEqual([]);
  });

  it("flags a flat scale", () => {
    const v = checkTypeHierarchy({ h1Px: [20], h2Px: [20], paragraphPx: [16] });
    expect(v.some((x) => x.includes("flat type scale"))).toBe(true);
    expect(v.some((x) => x.includes("not larger than h2"))).toBe(true);
  });

  it("flags h2 not above body", () => {
    expect(checkTypeHierarchy({ h1Px: [48], h2Px: [16], paragraphPx: [16] })).toEqual([
      "h2 16px (median) is not larger than body 16px",
    ]);
  });

  it("fails loudly when nothing to measure", () => {
    expect(checkTypeHierarchy({ h1Px: [], h2Px: [], paragraphPx: [16] })[0]).toContain(
      "no visible <h1>",
    );
    expect(checkTypeHierarchy({ h1Px: [40], h2Px: [], paragraphPx: [] })[0]).toContain(
      "no visible <p>",
    );
  });

  it("median", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(() => median([])).toThrow();
  });
});

describe("checkWebFontsDelivered", () => {
  const sample = {
    loadedFamilies: ['"Inter"', "Space Grotesk"],
    h1FontFamily: '"Space Grotesk", system-ui, sans-serif',
    bodyFontFamily: "Inter, sans-serif",
  };

  it("passes when no web font is declared", () => {
    expect(checkWebFontsDelivered([], { ...sample, loadedFamilies: [] })).toEqual([]);
  });

  it("passes when a declared family is loaded and rendered", () => {
    expect(checkWebFontsDelivered(["Space Grotesk", "JetBrains Mono"], sample)).toEqual([]);
  });

  it("flags a declared family that never loaded", () => {
    const v = checkWebFontsDelivered(["Inter"], { ...sample, loadedFamilies: [] });
    expect(v[0]).toContain("font delivery regression");
  });

  it("flags a loaded family nobody renders", () => {
    const v = checkWebFontsDelivered(["JetBrains Mono"], {
      ...sample,
      loadedFamilies: ["JetBrains Mono"],
    });
    expect(v.length).toBe(1);
  });

  it("primaryFamily unquotes and lowercases", () => {
    expect(primaryFamily(" 'Inter Tight', sans-serif")).toBe("inter tight");
  });
});

describe("findTemplateLeaks", () => {
  it("finds mustache tags and missing markers", () => {
    const html =
      '<h1>{{hero_title}}</h1><img src="{{theme_logo_url}}"><ul>{{#items}}<li></li>{{/items}}</ul>' +
      "<!-- caelo:missing reason=field-unset -->";
    expect(findTemplateLeaks(html)).toEqual([
      "{{hero_title}}",
      "{{theme_logo_url}}",
      "{{#items}}",
      "{{/items}}",
      "<!-- caelo:missing reason=field-unset -->",
    ]);
  });

  it("ignores script and style bodies and clean pages", () => {
    const html =
      "<style>.a{color:red}</style><script>var o={{a:1}}; var t='{{x}}';</script><p>Hello {world}</p>";
    expect(findTemplateLeaks(html)).toEqual([]);
  });
});

describe("compareStyleSnapshots", () => {
  it("matches equal colors across serialisations and tolerates font-size within bound", () => {
    expect(
      compareStyleSnapshots(
        "cta",
        {
          "background-color": "rgb(255, 0, 0)",
          "font-family": '"Inter", sans-serif',
          "font-size": "16px",
        },
        { "background-color": "color(srgb 1 0 0)", "font-family": "Inter", "font-size": "17px" },
        { "font-size": 0.1 },
      ),
    ).toEqual([]);
  });

  it("reports each differing property", () => {
    const v = compareStyleSnapshots(
      "h2",
      { "font-weight": "700", "font-size": "32px", "border-radius": "8px" },
      { "font-weight": "400", "font-size": "20px" },
      { "font-size": 0.15 },
    );
    expect(v).toEqual([
      "h2: font-weight 700 vs 400",
      "h2: font-size 32px vs 20px (beyond ±15%)",
      "h2: property border-radius missing on the second page",
    ]);
  });
});

describe("pickPrimaryCta", () => {
  it("skips ghost and neutral buttons, returns the first chromatic fill", () => {
    const cta = pickPrimaryCta([
      { text: "Learn more", styles: { "background-color": "rgba(0, 0, 0, 0)" } },
      { text: "Docs", styles: { "background-color": "rgb(17, 17, 17)" } },
      { text: "Start free", styles: { "background-color": "oklch(0.55 0.2 260)" } },
      { text: "Pricing", styles: { "background-color": "rgb(249, 115, 22)" } },
    ]);
    expect(cta?.text).toBe("Start free");
  });

  it("returns null without a filled chromatic button", () => {
    expect(
      pickPrimaryCta([{ text: "x", styles: { "background-color": "rgb(255, 255, 255)" } }]),
    ).toBeNull();
  });
});
