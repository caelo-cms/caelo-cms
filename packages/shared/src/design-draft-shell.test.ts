// SPDX-License-Identifier: MPL-2.0

/**
 * issue #375 — theme-shell composition for growth-time design drafts:
 * head order (fonts → theme vars → base), theme-asset placeholder
 * resolution incl. the loud unbound path, and the no-theme degradation.
 */

import { describe, expect, it } from "bun:test";
import { composeDesignDraftShell } from "./design-draft-shell.js";
import type { ComposeTheme } from "./preview-compose.js";
import type { ThemeDocument } from "./themes.js";

const TOKENS = {
  color: {
    background: { $type: "color", $value: "#ffffff" },
    primary: { $type: "color", $value: "#4f46e5" },
  },
} as ThemeDocument;

const THEME: ComposeTheme = {
  tokens: TOKENS,
  assets: {
    logo: { mediaId: "11111111-1111-4111-8111-111111111111", url: "/_caelo/media/logo/orig" },
    logoDark: null,
    favicon: null,
    socialShare: null,
  },
};

const FRAGMENT = `<section class="hero"><h1>Real headline</h1><style>.hero{color:var(--color-primary)}</style></section>`;

describe("composeDesignDraftShell (issue #375)", () => {
  it("wraps the fragment in fonts → theme vars → base head order", () => {
    const out = composeDesignDraftShell({
      fragmentHtml: FRAGMENT,
      theme: THEME,
      fonts: { css: "@font-face{font-family:Inter}", preloads: ["/_caelo/fonts/inter/aa.woff2"] },
      title: "Draft — bold",
    });
    expect(out.html).toStartWith("<!doctype html>");
    expect(out.html).toContain('<style data-source="fonts">@font-face{font-family:Inter}');
    expect(out.html).toContain('rel="preload" as="font"');
    expect(out.html).toContain('<style data-source="theme">');
    expect(out.html).toContain("--color-primary:#4f46e5");
    expect(out.html).toContain('<style data-source="base">');
    expect(out.html).toContain(FRAGMENT);
    expect(out.missingSlots).toEqual([]);
    const fontsAt = out.html.indexOf('data-source="fonts"');
    const themeAt = out.html.indexOf('data-source="theme"');
    const baseAt = out.html.indexOf('data-source="base"');
    expect(fontsAt).toBeLessThan(themeAt);
    expect(themeAt).toBeLessThan(baseAt);
  });

  it("substitutes bound theme-asset placeholders and flags unbound ones loudly", () => {
    const out = composeDesignDraftShell({
      fragmentHtml: `<img src="{{theme_logo_url}}"><img src="{{theme_favicon_url}}">`,
      theme: THEME,
      title: "assets",
    });
    expect(out.html).toContain('src="/_caelo/media/logo/orig"');
    // Unbound slot: placeholder survives raw (§2 no-fallbacks) + marker.
    expect(out.html).toContain("{{theme_favicon_url}}");
    expect(out.html).toContain("caelo:missing reason=theme-asset-unbound:favicon");
    expect(out.missingSlots).toEqual(["theme-asset-unbound:favicon"]);
  });

  it("renders without theme vars when no theme exists (visibly broken on purpose)", () => {
    const out = composeDesignDraftShell({ fragmentHtml: FRAGMENT, title: "no theme" });
    expect(out.html).not.toContain('data-source="theme"');
    expect(out.html).not.toContain('data-source="fonts"');
    expect(out.html).toContain('data-source="base"');
  });

  it("escapes the document title", () => {
    const out = composeDesignDraftShell({
      fragmentHtml: FRAGMENT,
      title: `<script>"x"</script>`,
    });
    expect(out.html).toContain("<title>&lt;script&gt;&quot;x&quot;&lt;/script&gt;</title>");
  });
});
