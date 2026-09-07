// SPDX-License-Identifier: MPL-2.0

/**
 * The external-host scanner.
 *
 * Its bias is the point: reporting a host that turns out to be harmless
 * costs one classification, while missing one ships an unasked request
 * to a third party. Every case here is chosen because a narrower
 * scanner would miss it — the stylesheet `url()`, the protocol-relative
 * `//host`, the `srcset` candidate list, the `fetch` in module JS.
 */

import { describe, expect, it } from "bun:test";
import { externalHosts } from "./scan.js";

describe("externalHosts", () => {
  it("finds an iframe embed", () => {
    expect(
      externalHosts({ html: '<iframe src="https://www.youtube.com/embed/abc"></iframe>' }),
    ).toEqual(["www.youtube.com"]);
  });

  it("finds a font or image pulled in from CSS", () => {
    // A url() in a stylesheet reaches the vendor exactly as surely as
    // an <img src> does, and is the easiest one to overlook.
    expect(
      externalHosts({ css: "@font-face{src:url(https://fonts.gstatic.com/x.woff2)}" }),
    ).toEqual(["fonts.gstatic.com"]);
  });

  it("finds a fetch in module JS", () => {
    expect(externalHosts({ js: 'fetch("https://api.example.org/track")' })).toEqual([
      "api.example.org",
    ]);
  });

  it("follows a protocol-relative URL", () => {
    expect(externalHosts({ html: '<script src="//cdn.example.net/a.js"></script>' })).toEqual([
      "cdn.example.net",
    ]);
  });

  it("reads every candidate in a srcset", () => {
    expect(
      externalHosts({
        html: '<img srcset="https://a.example.com/1x.png 1x, https://b.example.com/2x.png 2x">',
      }),
    ).toEqual(["a.example.com", "b.example.com"]);
  });

  it("finds a URL sitting bare in data, not markup", () => {
    // Authoring lifts an embed's address out of the HTML into a field
    // default or a content value, where it is a plain JSON string with
    // no src= around it. Missing this case would mean finding nothing
    // on exactly the modules this scanner exists for.
    expect(
      externalHosts({
        js: '[{"name":"iframesrc","default":"https://www.youtube.com/embed/abc"}]',
      }),
    ).toEqual(["www.youtube.com"]);
  });

  it("ignores everything that stays on this site", () => {
    expect(
      externalHosts({
        html: '<img src="/_caelo/media/hero.jpg"><a href="/about">x</a><a href="#top">y</a><a href="mailto:a@b.c">z</a>',
        css: "background:url(data:image/png;base64,AAA)",
      }),
    ).toEqual([]);
  });

  it("ignores an unsubstituted placeholder rather than reporting a bogus host", () => {
    // Module HTML is scanned before field substitution, so `{{…}}` is
    // normal here and must not read as a vendor.
    expect(externalHosts({ html: '<img src="{{hero_image}}">' })).toEqual([]);
  });

  it("deduplicates and sorts, so an unchanged module rescans identically", () => {
    expect(
      externalHosts({
        html: '<iframe src="https://www.youtube.com/embed/a"></iframe><iframe src="https://www.youtube.com/embed/b"></iframe><img src="https://maps.googleapis.com/x.png">',
      }),
    ).toEqual(["maps.googleapis.com", "www.youtube.com"]);
  });
});
