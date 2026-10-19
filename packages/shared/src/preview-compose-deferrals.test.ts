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
import { Parser } from "htmlparser2";
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

  it("keeps a withheld module's CSS and JS out of the page-wide bundles", () => {
    // Review of #456: the CSS/JS loops pushed every module's assets into
    // the page bundle, so a vendor URL in a withheld module's CSS or a
    // fetch() in its JS left before the visitor answered the banner.
    const vendor = {
      ...VIDEO,
      css: ".v{background:url(https://maps.gstatic.com/tile.png)}",
      js: 'fetch("https://api.vendor.example/track");',
    };
    const { html } = composePageWithLayout({
      templateHtml: TEMPLATE,
      templateCss: "",
      blocks: [{ blockName: "main", modules: [vendor] }],
      layoutHtml: LAYOUT,
      layoutCss: "",
      layoutBlocks: [],
      deferredModules: { [VIDEO.moduleId]: DEFERRAL },
    });
    const templateStart = html.indexOf("<template data-caelo-deferred-content>");
    const templateEnd = html.indexOf("</template>");
    for (const needle of ["maps.gstatic.com", "api.vendor.example"]) {
      expect(html.indexOf(needle)).toBeGreaterThan(templateStart);
      expect(html.indexOf(needle)).toBeLessThan(templateEnd);
      expect(html.lastIndexOf(needle)).toBeLessThan(templateEnd);
    }
    // The JS is parked inert, for the plugin runtime to run after hydration.
    expect(html).toContain(
      `<script type="text/plain" data-caelo-deferred-script="${VIDEO.moduleId}">`,
    );
  });

  it("still bundles the CSS and JS of modules that render normally", () => {
    const { html } = compose();
    expect(html).toContain(".v{}");
    expect(html).not.toContain("data-caelo-deferred-script");
  });

  it("escapes the wrapper attributes", () => {
    const { html } = compose({
      [VIDEO.moduleId]: { ...DEFERRAL, pluginSlug: 'x" onload="evil()' },
    });
    expect(html).not.toContain('onload="evil()"');
    expect(html).toContain("&quot;");
  });

  it("prevents </template>, </style>, and </script> inside withheld modules from breaking out of the inert template", () => {
    const breakout = {
      ...VIDEO,
      html: "<div></template><script>alert(1)</script></div>",
      css: ".v{content:'</style></template><script>alert(2)</script>'}",
      js: 'const x = "</script></template><script>alert(3)</script>";',
    };
    const { html } = composePageWithLayout({
      templateHtml: TEMPLATE,
      templateCss: "",
      blocks: [{ blockName: "main", modules: [breakout] }],
      layoutHtml: LAYOUT,
      layoutCss: "",
      layoutBlocks: [],
      deferredModules: { [VIDEO.moduleId]: DEFERRAL },
    });
    // None of the module's scripts may end up outside the inert template.
    expect(liveScripts(html).filter((s) => s.includes("alert"))).toEqual([]);
    expect(html).toContain("&lt;/template><script>alert(1)</script></div>");
  });

  it("parks JS that could end its <script> as base64 carrying the exact bytes", () => {
    // `0</script/.test(v)` is valid JS that any `<\/script` rewrite breaks,
    // and `<!--` + `<script` would keep the browser from ending the element.
    const js = "window.r = [0</script/.test('x'), '<!--<script>'];";
    const { html } = composePageWithLayout({
      templateHtml: TEMPLATE,
      templateCss: "",
      blocks: [{ blockName: "main", modules: [{ ...VIDEO, js }] }],
      layoutHtml: LAYOUT,
      layoutCss: "",
      layoutBlocks: [],
      deferredModules: { [VIDEO.moduleId]: DEFERRAL },
    });
    const m =
      /<script type="text\/plain" data-caelo-deferred-script="[^"]+" data-caelo-encoding="base64">([^<]*)<\/script>/.exec(
        html,
      );
    expect(m).not.toBeNull();
    expect(Buffer.from(m?.[1] ?? "", "base64").toString("utf8")).toBe(js);
  });

  it("escapes </style in live module CSS so it cannot add markup to <head>", () => {
    const { html } = composePageWithLayout({
      templateHtml: TEMPLATE,
      templateCss: "",
      blocks: [
        { blockName: "main", modules: [{ ...VIDEO, css: ".v{content:'</STYLE><meta x>'}" }] },
      ],
      layoutHtml: LAYOUT,
      layoutCss: "",
      layoutBlocks: [],
    });
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain(".v{content:'<\\/STYLE><meta x>'}");
    expect(head.toLowerCase()).not.toContain("</style><meta");
  });

  it("keeps a balanced nested <template> inside a withheld module intact", () => {
    const nested = { ...VIDEO, html: "<ul><template id=row><li>x</li></template></ul>" };
    const { html } = composePageWithLayout({
      templateHtml: TEMPLATE,
      templateCss: "",
      blocks: [{ blockName: "main", modules: [nested] }],
      layoutHtml: LAYOUT,
      layoutCss: "",
      layoutBlocks: [],
      deferredModules: { [VIDEO.moduleId]: DEFERRAL },
    });
    expect(html).toContain("<template id=row><li>x</li></template></ul></template></div>");
  });
});

/**
 * The text of every `<script>` a browser would run because it sits outside
 * any `<template>` — tokenized like a browser (style / script bodies are
 * raw text, so a `</template` inside them is not a tag).
 */
function liveScripts(html: string): string[] {
  const scripts: string[] = [];
  let templateDepth = 0;
  let current: string | null = null;
  const parser = new Parser({
    onopentag(name) {
      if (name === "template") templateDepth++;
      if (name === "script" && templateDepth === 0) current = "";
    },
    ontext(text) {
      if (current !== null) current += text;
    },
    onclosetag(name) {
      if (name === "template") templateDepth--;
      if (name === "script" && current !== null) {
        scripts.push(current);
        current = null;
      }
    },
  });
  parser.write(html);
  parser.end();
  return scripts;
}
