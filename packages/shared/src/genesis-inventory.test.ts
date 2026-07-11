// SPDX-License-Identifier: MPL-2.0

/**
 * issue #164 — inventory stage unit coverage: style extraction, color
 * usage attribution (including gradient stops), typography + spacing
 * histograms, outline scan, formatting, and the linear-parse budget on
 * adversarial input (ReDoS discipline, issue #113).
 */

import { describe, expect, it } from "bun:test";
import {
  extractDraftCss,
  formatGenesisInventory,
  inventoryGenesisDraft,
} from "./genesis-inventory.js";

const DRAFT = `<!doctype html><html><head><style>
  body { font-family: "Inter", sans-serif; color: #0f172a; background: #ffffff; margin: 0; }
  h1, h2 { font-family: "Playfair Display", serif; }
  h1 { font-size: clamp(2.5rem, 6vw, 4rem); }
  .hero { background: linear-gradient(135deg, #4f46e5, #7c3aed); padding: 6rem 2rem; color: #ffffff; }
  .card { background: #ffffff; border-radius: 12px; box-shadow: 0 4px 24px rgba(15,23,42,0.08); padding: 2rem; }
  .cta { background: #4f46e5; color: #ffffff; padding: 0.75rem 1.5rem; border-radius: 9999px; }
  .section-alt { background: #f5f3ff; padding: 6rem 2rem; }
</style></head>
<body>
  <header><nav>Brand</nav></header>
  <section class="hero"><h1>Bold headline for the brand</h1></section>
  <section class="section-alt"><h2>What we do</h2></section>
  <footer>© Brand</footer>
</body></html>`;

describe("inventoryGenesisDraft (issue #164)", () => {
  const inv = inventoryGenesisDraft(DRAFT);

  it("extracts style blocks linearly", () => {
    expect(extractDraftCss(DRAFT)).toContain("linear-gradient");
    expect(extractDraftCss("<p>no styles</p>")).toBe("");
  });

  it("attributes colors to properties with counts, including gradient stops", () => {
    const primary = inv.colors.find((c) => c.value === "#4f46e5");
    expect(primary).toBeDefined();
    expect(primary?.count).toBe(2); // gradient stop + .cta background
    expect(primary?.properties).toContain("background");
    const white = inv.colors.find((c) => c.value === "#ffffff");
    expect(white?.properties).toEqual(["background", "color"]);
  });

  it("collects gradients, fonts, sizes, spacing, radii, shadows", () => {
    expect(inv.gradients[0]).toBe("linear-gradient(135deg, #4f46e5, #7c3aed)");
    expect(inv.fontFamilies).toContain("Inter");
    expect(inv.fontFamilies).toContain("Playfair Display");
    expect(inv.fontSizes).toContain("clamp(2.5rem, 6vw, 4rem)");
    expect(inv.spacingValues).toContain("6rem");
    expect(inv.radiusValues).toContain("12px");
    expect(inv.shadows[0]).toContain("0 4px 24px");
  });

  it("builds the section outline in document order", () => {
    expect(inv.outline.map((o) => o.tag)).toEqual([
      "header",
      "nav",
      "section",
      "h1",
      "section",
      "h2",
      "footer",
    ]);
    expect(inv.outline[3]?.text).toContain("Bold headline");
  });

  it("formats a compact prompt-friendly report", () => {
    const report = formatGenesisInventory(inv);
    expect(report).toContain("#4f46e5×2[background]");
    expect(report).toContain("Font families: Inter, Playfair Display");
    expect(report).toContain("Outline: <header>");
  });

  it("stays within budget on adversarial input (linear parse)", () => {
    const evil = `<style>${"a{b:c;".repeat(30_000)}</style>${"<section>".repeat(5_000)}`;
    const t0 = performance.now();
    inventoryGenesisDraft(evil);
    expect(performance.now() - t0).toBeLessThan(250);
  });
});
