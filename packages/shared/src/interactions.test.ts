// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  findInteractionIds,
  INTERACTION_MARKUP_CONTRACT,
  INTERACTIONS,
  interactionAssets,
} from "./interactions.js";

describe("findInteractionIds (issue #160)", () => {
  it("finds kit ids in either quote style and reports unknown ones", () => {
    const html =
      "<div data-caelo-ui=\"tabs\"></div><section data-caelo-ui='carousel'></section>" +
      '<div data-caelo-ui="tabs"></div><div data-caelo-ui="lightbox"></div>';
    expect(findInteractionIds(html)).toEqual({
      known: ["tabs", "carousel"],
      unknown: ["lightbox"],
    });
  });

  it("ignores the attribute text when it appears as escaped page content", () => {
    expect(findInteractionIds("<p>use data-caelo-ui=&quot;tabs&quot;</p>").known).toEqual([]);
  });

  it("does not treat inherited object keys as kit ids", () => {
    expect(findInteractionIds('<div data-caelo-ui="toString"></div>')).toEqual({
      known: [],
      unknown: ["toString"],
    });
  });
});

describe("interactionAssets (issue #160)", () => {
  it("emits in registry order regardless of the order asked", () => {
    const out = interactionAssets(new Set(["carousel", "accordion"] as const));
    expect(out.js).toEqual([INTERACTIONS.accordion.js, INTERACTIONS.carousel.js]);
    expect(out.css).toEqual([INTERACTIONS.accordion.css, INTERACTIONS.carousel.css]);
  });
});

describe("the kit", () => {
  it("documents every snippet's markup contract for the AI", () => {
    for (const id of Object.keys(INTERACTIONS)) {
      expect(INTERACTION_MARKUP_CONTRACT).toContain(`\`${id}\``);
    }
  });

  it("carries no aesthetics: no color literals in any snippet's CSS", () => {
    for (const { css } of Object.values(INTERACTIONS)) {
      expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i);
    }
  });

  it("binds by delegation so modules inserted after load still work", () => {
    for (const { js } of Object.values(INTERACTIONS)) {
      expect(js).toContain("document.addEventListener(");
      expect(js).not.toContain("querySelectorAll('.caelo-nav-menu')");
    }
  });
});
