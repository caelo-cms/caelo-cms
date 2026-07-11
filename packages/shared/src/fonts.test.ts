// SPDX-License-Identifier: MPL-2.0

/**
 * issue #150 — unit coverage for the pure web-font helpers: request
 * extraction from typography tokens, system-stack classification, css2
 * payload parsing, self-hosted @font-face emission, preload selection.
 */

import { describe, expect, it } from "bun:test";
import {
  buildFontFaceCss,
  extractThemeFontRequests,
  fontUnresolvableMarker,
  googleFontsCssUrl,
  isSystemFontFamily,
  parseFontsCss,
  type ResolvedFontFace,
  selectPreloadFaces,
} from "./fonts.js";
import type { ThemeDocument } from "./themes.js";

const TOKENS = {
  typography: {
    body: { $type: "typography", $value: { fontFamily: '"Inter", sans-serif', fontWeight: 400 } },
    heading: {
      $type: "typography",
      $value: { fontFamily: "Playfair Display, serif", fontWeight: 700 },
    },
    emphasis: { $type: "typography", $value: { fontFamily: "Inter", fontWeight: "bold" } },
    mono: { $type: "typography", $value: { fontFamily: "ui-monospace, Menlo, monospace" } },
    aliasing: { $type: "typography", $value: "{typography.body}" },
  },
} as unknown as ThemeDocument;

describe("extractThemeFontRequests (issue #150)", () => {
  it("collects web families with merged weights + roles, skips system stacks and aliases", () => {
    const reqs = extractThemeFontRequests(TOKENS);
    const byFamily = new Map(reqs.map((r) => [r.family, r]));
    expect([...byFamily.keys()].sort()).toEqual(["Inter", "Playfair Display"]);
    // 400 from body + bold→700 from emphasis, merged and sorted.
    expect(byFamily.get("Inter")?.weights).toEqual([400, 700]);
    expect(byFamily.get("Inter")?.roles.sort()).toEqual(["body", "emphasis"]);
    expect(byFamily.get("Playfair Display")?.weights).toEqual([700]);
  });

  it("defaults weights when the theme declares none", () => {
    const reqs = extractThemeFontRequests({
      typography: { body: { $value: { fontFamily: "Poppins" } } },
    } as unknown as ThemeDocument);
    expect(reqs[0]?.weights).toEqual([400, 700]);
  });

  it("returns [] for token documents without typography", () => {
    expect(extractThemeFontRequests({} as ThemeDocument)).toEqual([]);
  });
});

describe("isSystemFontFamily", () => {
  it("classifies generic keywords and OS staples as system", () => {
    for (const f of ["system-ui", "sans-serif", "Georgia", "  Menlo ", "SEGOE UI"]) {
      expect(isSystemFontFamily(f)).toBe(true);
    }
  });
  it("classifies hosted-web staples as web fonts", () => {
    for (const f of ["Inter", "Poppins", "Playfair Display", "Roboto"]) {
      expect(isSystemFontFamily(f)).toBe(false);
    }
  });
});

describe("googleFontsCssUrl", () => {
  it("encodes the family and joins weights", () => {
    expect(
      googleFontsCssUrl({ family: "Playfair Display", weights: [400, 700], roles: ["heading"] }),
    ).toBe("https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&display=swap");
  });
});

const CSS2_FIXTURE = `
/* latin-ext */
@font-face {
  font-family: 'Poppins';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/poppins/v23/pxiEyp8kv8JHgFVrJJnecmNE.woff2) format('woff2');
  unicode-range: U+0100-02BA;
}
/* latin */
@font-face {
  font-family: 'Poppins';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/poppins/v23/pxiByp8kv8JHgFVrLCz7Z1xlEA.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131;
}
@font-face {
  font-family: 'Poppins';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/poppins/v23/pxiEyp8kv8JHgFVrJJfecg.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153;
}
`;

describe("parseFontsCss", () => {
  it("parses css2 @font-face blocks into face records", () => {
    const faces = parseFontsCss(CSS2_FIXTURE);
    expect(faces).toHaveLength(3);
    expect(faces[0]).toEqual({
      family: "Poppins",
      style: "normal",
      weight: "400",
      unicodeRange: "U+0100-02BA",
      srcUrl: "https://fonts.gstatic.com/s/poppins/v23/pxiEyp8kv8JHgFVrJJnecmNE.woff2",
    });
  });

  it("returns [] on payloads without woff URLs — the caller's loud-failure signal", () => {
    expect(parseFontsCss("body{color:red}")).toEqual([]);
  });
});

describe("buildFontFaceCss + selectPreloadFaces", () => {
  const faces: ResolvedFontFace[] = parseFontsCss(CSS2_FIXTURE).map((f, i) => ({
    family: f.family,
    style: f.style,
    weight: f.weight,
    unicodeRange: f.unicodeRange,
    publicUrl: `/_assets/fonts/poppins/${i}.woff2`,
  }));

  it("emits self-hosted @font-face with font-display: swap", () => {
    const css = buildFontFaceCss(faces);
    expect(css).toContain('font-family:"Poppins"');
    expect(css).toContain("font-display:swap");
    expect(css).toContain("url(/_assets/fonts/poppins/0.woff2) format('woff2')");
    expect(css).toContain("unicode-range:U+0100-02BA;");
    expect(css).not.toContain("fonts.gstatic.com");
  });

  it("preloads one latin normal-style face per family at the lowest weight", () => {
    const picks = selectPreloadFaces(faces);
    // Latin faces are weight 700 (index 1) and 400 (index 2) → lowest is 400.
    expect(picks).toHaveLength(1);
    expect(picks[0]?.weight).toBe("400");
    expect(picks[0]?.publicUrl).toBe("/_assets/fonts/poppins/2.woff2");
  });
});

describe("fontUnresolvableMarker", () => {
  it("matches the theme-asset-unbound marker convention", () => {
    expect(fontUnresolvableMarker("Poppins")).toBe("theme-font-unresolvable:Poppins");
  });
});
