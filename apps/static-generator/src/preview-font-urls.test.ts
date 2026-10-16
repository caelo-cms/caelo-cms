// SPDX-License-Identifier: MPL-2.0

/**
 * A module's CSS that copied an @font-face rule out of the editor preview
 * (`/_caelo/fonts/...`) must not ship a font URL only the admin serves
 * (e2e-livedit run 38867358894: the live homepage 404ed its Inter slice).
 */

import { describe, expect, it } from "bun:test";
import { rewritePreviewFontUrls } from "./preview-font-urls.js";

const shipped = new Set(["inter/29ede7bd4be32ab0.woff2", "pinned/abc.latin.0123456789ab.woff2"]);

describe("rewritePreviewFontUrls", () => {
  it("points a preview font URL at the file the build ships", () => {
    const pages = [
      {
        relPath: "index.html",
        html: `<style>@font-face{font-family:"Inter";font-display:optional;src:url(/_caelo/fonts/inter/29ede7bd4be32ab0.woff2) format('woff2')}</style><link rel="preload" href="/_assets/fonts/inter/29ede7bd4be32ab0.woff2">`,
      },
      {
        relPath: "about/index.html",
        html: `<p>src:url("/_caelo/fonts/pinned/abc.latin.0123456789ab.woff2")</p>`,
      },
    ];
    rewritePreviewFontUrls(pages, shipped);
    expect(pages[0]?.html).toContain("src:url(/_assets/fonts/inter/29ede7bd4be32ab0.woff2)");
    expect(pages[0]?.html).not.toContain("/_caelo/fonts/");
    expect(pages[1]?.html).toContain(`"/_assets/fonts/pinned/abc.latin.0123456789ab.woff2"`);
  });

  it("leaves pages without preview font URLs untouched", () => {
    const html = `<link rel="preload" href="/_assets/fonts/inter/29ede7bd4be32ab0.woff2"><img src="/_assets/logo.png">`;
    const pages = [{ relPath: "index.html", html }];
    rewritePreviewFontUrls(pages, shipped);
    expect(pages[0]?.html).toBe(html);
  });

  it("fails the build on a font URL the build does not ship, naming page and URL", () => {
    const pages = [
      { relPath: "index.html", html: "src:url(/_caelo/fonts/inter/ffffffffffffffff.woff2)" },
    ];
    expect(() => rewritePreviewFontUrls(pages, shipped)).toThrow(
      /index\.html: \/_caelo\/fonts\/inter\/ffffffffffffffff\.woff2.*var\(--font-body\)/,
    );
  });
});
