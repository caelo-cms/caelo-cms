// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  type ProposedModuleBlock,
  rebuiltHeaderHasLogoRef,
  sourceHeaderHasLogoImage,
} from "./logo-signal.js";

describe("sourceHeaderHasLogoImage", () => {
  it("detects the searchviu-style header logo <img> (the live-run defect)", () => {
    // The real source header markup: an <a> to home wrapping a PNG logo.
    const blocks: ProposedModuleBlock[] = [
      {
        blockName: "header",
        html: '<header><a href="/"><img src="https://www.searchviu.com/wp-content/uploads/2023/02/d3babe41-searchviu-logo2x-300x300.png" alt="searchVIU"></a><nav>…</nav></header>',
      },
      { blockName: "hero", html: "<section><h1>Hello</h1></section>" },
    ];
    const r = sourceHeaderHasLogoImage(blocks);
    expect(r.hasLogo).toBe(true);
    expect(r.evidence).toContain("searchviu-logo2x");
  });

  it("treats the FIRST block's <img> as the logo even without a named header", () => {
    const blocks: ProposedModuleBlock[] = [
      { blockName: "", html: '<div><a href="/"><img src="/brandmark.svg" alt="Acme"></a></div>' },
    ];
    expect(sourceHeaderHasLogoImage(blocks).hasLogo).toBe(true);
  });

  it("detects a logo-tokened <img> in a NON-header block (WordPress custom-logo)", () => {
    const blocks: ProposedModuleBlock[] = [
      { blockName: "hero", html: "<section><h1>Hi</h1></section>" },
      {
        blockName: "topbar",
        html: '<div class="site-branding"><img class="custom-logo" src="/wp/logo.png" alt=""></div>',
      },
    ];
    expect(sourceHeaderHasLogoImage(blocks).hasLogo).toBe(true);
  });

  it("detects an inline <svg> logo in the header block", () => {
    const blocks: ProposedModuleBlock[] = [
      {
        blockName: "masthead",
        html: "<header><svg viewBox='0 0 10 10'><path d='M0 0h10'/></svg></header>",
      },
    ];
    expect(sourceHeaderHasLogoImage(blocks).hasLogo).toBe(true);
  });

  it("does NOT flag a genuinely text/CSS wordmark header (no source image)", () => {
    // A site whose brand really is styled text — a redraw is acceptable
    // here, so the guardrail must stay quiet.
    const blocks: ProposedModuleBlock[] = [
      {
        blockName: "header",
        html: '<header><a class="wordmark" href="/">Acme<span>Co</span></a><nav><a href="/x">X</a></nav></header>',
      },
      { blockName: "hero", html: "<section><h1>Welcome</h1></section>" },
    ];
    expect(sourceHeaderHasLogoImage(blocks).hasLogo).toBe(false);
  });

  it("ignores a body-only <img> that is not header-scoped and not logo-tokened", () => {
    const blocks: ProposedModuleBlock[] = [
      { blockName: "header", html: '<header><a class="wordmark" href="/">Acme</a></header>' },
      { blockName: "gallery", html: '<figure><img src="/photo1.jpg" alt="a photo"></figure>' },
    ];
    expect(sourceHeaderHasLogoImage(blocks).hasLogo).toBe(false);
  });

  it("handles empty / missing blocks without throwing", () => {
    expect(sourceHeaderHasLogoImage([]).hasLogo).toBe(false);
    expect(sourceHeaderHasLogoImage([{ blockName: null, html: null }]).hasLogo).toBe(false);
  });
});

describe("rebuiltHeaderHasLogoRef", () => {
  it("passes when the header uses the {{theme_logo_url}} placeholder", () => {
    expect(
      rebuiltHeaderHasLogoRef('<header><img src="{{theme_logo_url}}" alt="Acme"></header>'),
    ).toBe(true);
  });

  it("passes on the dark-variant placeholder too", () => {
    expect(rebuiltHeaderHasLogoRef("<header><img src='{{ theme_logo_dark_url }}'></header>")).toBe(
      true,
    );
  });

  it("passes when the header <img> points at Caelo media (migrated logo)", () => {
    expect(
      rebuiltHeaderHasLogoRef(
        '<header><a href="/"><img src="/_caelo/media/11111111-1111-1111-1111-111111111111/orig" alt="searchVIU"></a></header>',
      ),
    ).toBe(true);
  });

  it("FAILS on a hand-authored text/CSS wordmark (the redraw we catch)", () => {
    expect(
      rebuiltHeaderHasLogoRef(
        '<header><a class="sv-header__logo" href="/">search<span>VIU</span></a></header>',
      ),
    ).toBe(false);
  });

  it("does NOT pass a header <img> still hotlinked to the source host", () => {
    // Left-hotlinked is its own defect the media report surfaces; it is
    // not a Caelo-hosted logo, so this signal stays false.
    expect(
      rebuiltHeaderHasLogoRef('<header><img src="https://www.searchviu.com/logo.png"></header>'),
    ).toBe(false);
  });

  it("is false for empty header html", () => {
    expect(rebuiltHeaderHasLogoRef("")).toBe(false);
  });
});
