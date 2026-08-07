// SPDX-License-Identifier: MPL-2.0

/**
 * Withheld modules in the composer (#450).
 *
 * The assertion that matters is the `<template>`. A browser parses its
 * contents but instantiates nothing inside it — no iframe, image,
 * script or stylesheet is fetched — so a video module behind a consent
 * gate genuinely does not reach YouTube. Hiding the module with CSS or
 * stripping its attributes in script would both leave the request
 * already sent, which is the failure this whole mechanism exists to
 * prevent. If a change ever moves the real markup out of the template,
 * these tests are the ones that must fail.
 */

import { describe, expect, it } from "bun:test";
import { type ComposeDeferral, composePageWithLayout } from "./preview-compose.js";

const LAYOUT = '<html><head></head><body><caelo-slot name="content">_</caelo-slot></body></html>';
const TEMPLATE = '<body><caelo-slot name="main">_</caelo-slot></body>';

const VIDEO = {
  moduleId: "11111111-1111-1111-1111-111111111111",
  slug: "video-hero",
  displayName: "Video hero",
  html: '<iframe src="https://www.youtube.com/embed/x"></iframe>',
  css: ".v{}",
  js: "",
};

const DEFERRAL: ComposeDeferral = {
  pluginSlug: "consent-manager",
  reason: "marketing",
  placeholderModuleSlug: "consent-placeholder",
  placeholderHtml: '<div class="ph"><button data-consent-accept>Allow</button></div>',
  placeholderCss: ".ph{border:1px dashed}",
};

function compose(deferredModules?: Record<string, ComposeDeferral>) {
  return composePageWithLayout({
    templateHtml: TEMPLATE,
    templateCss: "",
    blocks: [{ blockName: "main", modules: [VIDEO] }],
    layoutHtml: LAYOUT,
    layoutCss: "",
    layoutBlocks: [],
    ...(deferredModules ? { deferredModules } : {}),
  });
}

describe("composer — withheld modules", () => {
  it("parks the real markup in an inert template behind the placeholder", () => {
    const { html } = compose({ [VIDEO.moduleId]: DEFERRAL });

    expect(html).toContain('data-caelo-deferred="consent-manager"');
    expect(html).toContain('data-reason="marketing"');
    expect(html).toContain("data-consent-accept");

    // The iframe survives — but ONLY inside the template, so nothing is
    // requested until the plugin's runtime clones it out.
    const template = html.slice(
      html.indexOf("<template data-caelo-deferred-content>"),
      html.indexOf("</template>"),
    );
    expect(template).toContain("youtube.com");
    expect(html.indexOf("youtube.com")).toBeGreaterThan(
      html.indexOf("<template data-caelo-deferred-content>"),
    );
  });

  it("brings the placeholder's own CSS onto the page", () => {
    // Otherwise the placeholder renders unstyled: it is a module like
    // any other, just never placed by hand.
    expect(compose({ [VIDEO.moduleId]: DEFERRAL }).html).toContain(".ph{border:1px dashed}");
  });

  it("renders the module untouched when nothing withholds it", () => {
    const { html } = compose();
    expect(html).toContain("youtube.com");
    expect(html).not.toContain("data-caelo-deferred");
  });

  it("withholds a module placed in the LAYOUT too", () => {
    // Site-wide chrome is where a video embed in a footer would live;
    // gating only page blocks would leak on every page at once.
    const { html } = composePageWithLayout({
      templateHtml: TEMPLATE,
      templateCss: "",
      blocks: [],
      layoutHtml:
        '<html><head></head><body><caelo-slot name="content">_</caelo-slot><caelo-slot name="footer">_</caelo-slot></body></html>',
      layoutCss: "",
      layoutBlocks: [{ blockName: "footer", modules: [VIDEO] }],
      deferredModules: { [VIDEO.moduleId]: DEFERRAL },
    });
    expect(html).toContain('data-caelo-deferred="consent-manager"');
    expect(html).toContain("<template data-caelo-deferred-content>");
  });

  it("escapes the wrapper attributes", () => {
    const { html } = compose({
      [VIDEO.moduleId]: { ...DEFERRAL, pluginSlug: 'x" onload="evil()' },
    });
    expect(html).not.toContain('onload="evil()"');
    expect(html).toContain("&quot;");
  });
});
