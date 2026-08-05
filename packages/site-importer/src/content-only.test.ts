// SPDX-License-Identifier: MPL-2.0

/**
 * issue #424 — read-time content-only shaping: strip layout/template-owned
 * boilerplate via the detector's own signatures, collapse duplicate nav
 * DOM, filter the preset-token dump to values in use, and always count
 * what was removed (CLAUDE.md §2 — never silent).
 */

import { describe, expect, it } from "bun:test";
import { detectBoilerplate } from "./boilerplate.js";
import {
  type BoilerplateStripTarget,
  collapseDuplicateNavs,
  filterPresetThemeTokens,
  stripBoilerplateSubtrees,
} from "./content-only.js";
import { stripConsentSubtrees } from "./extractor.js";

const NAV =
  '<nav class="main-nav"><ul><li><a href="/pricing">Pricing</a></li><li><a href="/blog">Blog</a></li><li><a href="/about">About us</a></li></ul></nav>';
const CTA =
  '<section class="newsletter-cta"><div><h3>Join our newsletter</h3><p>Monthly product updates, no spam ever.</p><a href="/signup">Subscribe now</a></div></section>';
const SHARED_TWO_PAGES =
  '<aside class="promo"><div><h4>Spring sale</h4><p>Twenty percent off every plan until the end of March.</p><a href="/sale">Get the deal</a></div></aside>';

function page(unique: string, extra = ""): string {
  return `${NAV}\n<main><article><h1>${unique} heading</h1><p>${unique} body copy with plenty of unique text so the walker records it as content.</p><a href="/${unique}">Read ${unique}</a></article></main>\n${extra}${CTA}`;
}

/** Real detector output → strip targets, exactly as the tool derives them
 *  from the stored run summary. */
function detectTargets(pages: Array<{ pageId: string; html: string }>): BoilerplateStripTarget[] {
  const report = detectBoilerplate(pages, { minPages: 2 });
  return report.candidates.map((c) => ({
    signature: c.signature,
    kind: c.kind,
    tag: c.tag,
    suggestedPlacement: c.suggestedPlacement,
    sampleText: c.sampleText,
  }));
}

describe("stripBoilerplateSubtrees", () => {
  const pages = [
    { pageId: "p1", html: page("alpha", SHARED_TWO_PAGES) },
    { pageId: "p2", html: page("beta", SHARED_TWO_PAGES) },
    { pageId: "p3", html: page("gamma") },
  ];

  it("removes layout-placed candidates from one page and keeps its content", () => {
    const targets = detectTargets(pages);
    expect(targets.some((t) => t.suggestedPlacement === "layout")).toBe(true);

    const { html, stripped } = stripBoilerplateSubtrees(pages[0]!.html, targets);
    // Site-wide nav + CTA (on all 3 pages) are layout-owned → gone.
    expect(html).not.toContain("main-nav");
    expect(html).not.toContain("Join our newsletter");
    // The page's own content survives untouched.
    expect(html).toContain("alpha heading");
    expect(html).toContain("alpha body copy");
    expect(stripped.length).toBeGreaterThanOrEqual(2);
    for (const s of stripped) expect(["layout", "template"]).toContain(s.placement);
  });

  it("does NOT strip content_instance candidates — shared content is not chrome", () => {
    const targets = detectTargets(pages);
    // The 2-of-3-pages promo is a recurring content instance, not chrome.
    const promo = targets.find((t) => t.sampleText.includes("spring sale"));
    expect(promo?.suggestedPlacement).toBe("content_instance");

    const { html } = stripBoilerplateSubtrees(pages[0]!.html, targets);
    expect(html).toContain("Spring sale");
  });

  it("counts each removed subtree exactly once (no nested double-count)", () => {
    const targets = detectTargets(pages);
    const { stripped } = stripBoilerplateSubtrees(pages[2]!.html, targets);
    // Page 3 carries nav + CTA only — at most those can be stripped.
    expect(stripped.length).toBeLessThanOrEqual(2);
  });

  it("returns the input untouched when no target matches", () => {
    const html = "<main><p>Nothing repeated here, just a lone paragraph of text.</p></main>";
    const res = stripBoilerplateSubtrees(html, detectTargets(pages));
    expect(res.html).toBe(html);
    expect(res.stripped).toEqual([]);
  });
});

describe("collapseDuplicateNavs", () => {
  it("collapses a mobile nav that duplicates the desktop nav's text", () => {
    const html = `${NAV}<div class="mobile-menu" role="navigation"><ul><li><a href="/pricing">Pricing</a></li><li><a href="/blog">Blog</a></li><li><a href="/about">About us</a></li></ul></div><main><p>Body</p></main>`;
    const { html: out, removed } = collapseDuplicateNavs(html);
    expect(removed).toBe(1);
    // The first (desktop) nav survives; the role="navigation" clone is gone.
    expect(out).toContain("main-nav");
    expect(out).not.toContain("mobile-menu");
    expect(out).toContain("<main><p>Body</p></main>");
  });

  it("keeps navs whose text differs", () => {
    const html = `${NAV}<nav class="footer-nav"><a href="/imprint">Imprint</a><a href="/privacy">Privacy</a></nav>`;
    const { removed } = collapseDuplicateNavs(html);
    expect(removed).toBe(0);
  });

  it("ignores text-less (icon-only) navs", () => {
    const html =
      '<nav class="social"><a href="/x" aria-label="X"></a></nav><nav class="social2"><a href="/y" aria-label="Y"></a></nav>';
    const { html: out, removed } = collapseDuplicateNavs(html);
    expect(removed).toBe(0);
    expect(out).toBe(html);
  });
});

describe("filterPresetThemeTokens", () => {
  const tokens = {
    "--brand-primary": "#dc2626",
    "--wp--preset--color--pale-pink": "#f78da7",
    "--wp--preset--color--vivid-red": "#cf2e2e",
    "--wp--preset--color--brand-alias": "var(--wp--preset--color--vivid-red)",
    "--wp--preset--font-size--huge": "42px",
    "--wp--preset--shadow--natural": "6px 6px 9px rgba(0, 0, 0, 0.2)",
  };

  it("keeps non-preset tokens, drops unreferenced presets, and counts the drops", () => {
    const html = "<main><p>No token references at all.</p></main>";
    const { tokens: kept, droppedPresetTokens } = filterPresetThemeTokens(tokens, html);
    expect(kept).toEqual({ "--brand-primary": "#dc2626" });
    expect(droppedPresetTokens).toBe(5);
  });

  it("keeps presets referenced via var() and follows preset-to-preset aliases", () => {
    const html = '<div style="color: var(--wp--preset--color--brand-alias)">Styled</div>';
    const { tokens: kept, droppedPresetTokens } = filterPresetThemeTokens(tokens, html);
    expect(kept["--wp--preset--color--brand-alias"]).toBe("var(--wp--preset--color--vivid-red)");
    // The alias's target survives transitively.
    expect(kept["--wp--preset--color--vivid-red"]).toBe("#cf2e2e");
    expect(kept["--wp--preset--color--pale-pink"]).toBeUndefined();
    expect(droppedPresetTokens).toBe(3);
  });

  it("keeps presets consumed through block-theme has-* classes", () => {
    const html = '<p class="has-pale-pink-background-color has-huge-font-size">Styled text</p>';
    const { tokens: kept, droppedPresetTokens } = filterPresetThemeTokens(tokens, html);
    expect(kept["--wp--preset--color--pale-pink"]).toBe("#f78da7");
    expect(kept["--wp--preset--font-size--huge"]).toBe("42px");
    expect(kept["--wp--preset--shadow--natural"]).toBeUndefined();
    expect(droppedPresetTokens).toBe(3);
  });

  it("is a no-op (plus zero count) when the dump has no presets", () => {
    const plain = { "--color-primary": "#111111" };
    const { tokens: kept, droppedPresetTokens } = filterPresetThemeTokens(plain, "<p>x</p>");
    expect(kept).toEqual(plain);
    expect(droppedPresetTokens).toBe(0);
  });
});

describe("stripConsentSubtrees", () => {
  it("returns the removal count alongside the stripped html", () => {
    const html =
      '<main><p>Real content stays.</p></main><div id="cmplz-cookiebanner-container"><p>Manage Consent — we use cookies.</p></div>';
    const { html: out, removed } = stripConsentSubtrees(html);
    expect(removed).toBe(1);
    expect(out).toContain("Real content stays.");
    expect(out).not.toContain("Manage Consent");
  });
});
