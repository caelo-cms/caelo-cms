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
import { deferralReason, externalHosts, moduleHosts } from "./scan.js";

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

describe("moduleHosts", () => {
  it("finds a vendor that only a placement's content values point at", () => {
    // Authoring lifts the embed URL into a field; the module code is clean.
    expect(
      moduleHosts({
        html: '<iframe src="{{video_url}}"></iframe>',
        css: "",
        js: "",
        fields: [{ name: "video_url" }],
        contentValues: [{ video_url: "https://www.youtube.com/embed/abc" }],
      }),
    ).toEqual(["www.youtube.com"]);
  });
});

describe("moduleHosts counts only what loads with the page", () => {
  const mod = (
    html: string,
    extra: { css?: string; js?: string; fields?: unknown; contentValues?: unknown[] } = {},
  ) =>
    moduleHosts({
      html,
      css: extra.css ?? "",
      js: extra.js ?? "",
      fields: extra.fields ?? [],
      contentValues: extra.contentValues ?? [],
    });

  it("ignores a footer link to an external site (the CI homepage case)", () => {
    // A link contacts nobody until clicked; withholding the footer for it
    // blanked the whole preview (run 36619865351).
    expect(
      mod('<footer><a href="{{license_href}}">{{license_label}}</a></footer>', {
        fields: [{ name: "license_href", default: "https://www.mozilla.org/MPL/2.0/" }],
      }),
    ).toEqual([]);
    expect(mod('<a href="https://example.org/about">About</a>')).toEqual([]);
  });

  it("ignores non-loading link relations and form targets", () => {
    expect(mod('<link rel="canonical" href="https://example.org/x">')).toEqual([]);
    expect(mod('<form action="https://forms.example.org/submit"></form>')).toEqual([]);
  });

  it("counts embeds, stylesheets and CSS backgrounds, literal or via fields", () => {
    expect(mod('<iframe src="https://www.youtube.com/embed/x"></iframe>')).toEqual([
      "www.youtube.com",
    ]);
    expect(
      mod('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">'),
    ).toEqual(["fonts.googleapis.com"]);
    expect(
      mod('<div style="background:url({{bg}})"></div>', {
        contentValues: [{ bg: "https://cdn.example.net/a.jpg" }],
      }),
    ).toEqual(["cdn.example.net"]);
    expect(
      mod('{{#slides}}<img src="{{src}}">{{/slides}}', {
        contentValues: [{ slides: [{ src: "https://images.example.com/1.jpg" }] }],
      }),
    ).toEqual(["images.example.com"]);
  });

  it("counts any non-link attribute when the module's own JS may load it", () => {
    const html = '<div data-video="https://player.vimeo.com/video/1"></div>';
    expect(mod(html)).toEqual([]);
    expect(mod(html, { js: "document.querySelectorAll('[data-video]').forEach(load);" })).toEqual([
      "player.vimeo.com",
    ]);
  });

  it("ignores SVG namespace declarations, even in a module with JS", () => {
    // PR #641 homepage run: a header with a menu-toggle script and an
    // inline SVG icon was withheld behind "www.w3.org" — the site header
    // vanished until the AI classified a namespace URI as an embed.
    const icon =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
    const js = "document.querySelector('.toggle').addEventListener('click', open);";
    expect(mod(icon, { js })).toEqual([]);
    // What the SVG does load still counts.
    expect(
      mod(
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://cdn.example.net/a.png"/></svg>',
        {
          js,
        },
      ),
    ).toEqual(["cdn.example.net"]);
  });

  it("ignores every standard XML namespace URI, matched exactly", () => {
    const js = "init();";
    for (const ns of [
      "http://www.w3.org/2000/svg",
      "http://www.w3.org/1999/xlink",
      "http://www.w3.org/1999/xhtml",
      "http://www.w3.org/1998/Math/MathML",
      "http://www.w3.org/XML/1998/namespace",
    ]) {
      expect(mod(`<svg xmlns:x="${ns}"></svg>`, { js })).toEqual([]);
    }
    // Not exact (trailing path) → an ordinary URL, scanned.
    expect(mod('<svg xmlns="http://www.w3.org/2000/svg/track"></svg>', { js })).toEqual([
      "www.w3.org",
    ]);
  });

  it("still scans a non-standard xmlns value a script can read and fetch", () => {
    // Smuggling: the namespace slot carries a tracker URL the module's JS
    // fetches. Exempting every xmlns:* would let it past the consent gate.
    const html =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:telemetry="https://tracker.example/collect"></svg>';
    const js = 'fetch(document.querySelector("svg").getAttribute("xmlns:telemetry"));';
    expect(mod(html, { js })).toEqual(["tracker.example"]);
    // Through a field placeholder too.
    expect(
      mod('<svg xmlns:t="{{ns}}"></svg>', {
        js,
        contentValues: [{ ns: "https://tracker.example/collect" }],
      }),
    ).toEqual(["tracker.example"]);
  });

  it("still reads the module's JS over-inclusively", () => {
    expect(
      mod("<div></div>", { js: 'const api = "https://api.tracker.example/collect";' }),
    ).toEqual(["api.tracker.example"]);
  });
});

describe("deferralReason (render-time gate)", () => {
  const classify = (hosts: ReadonlyArray<string>) =>
    hosts.every((h) => h === "www.youtube.com") ? "marketing" : null;
  const yt = ["www.youtube.com"];

  it("renders a module that reaches no third party", () => {
    expect(deferralReason([], undefined, classify)).toBeNull();
  });

  it("withholds a module the background scan has not seen yet", () => {
    // Review of #456: with no guard row the module used to render
    // normally, so anything published inside the 5-minute scan window
    // shipped ungated.
    expect(deferralReason(yt, undefined, classify)).toBe("marketing");
    expect(deferralReason(["tracker.unknown.example"], undefined, classify)).toBe("unclassified");
  });

  it("honours the operator's verdict only for the hosts it was made about", () => {
    const allowed = { detected_hosts: yt, status: "allowed" as const, category_key: "marketing" };
    expect(deferralReason(yt, allowed, classify)).toBeNull();
    // The module now also reaches a second vendor: the old "allowed" no
    // longer applies.
    expect(deferralReason([...yt, "tracker.unknown.example"], allowed, classify)).toBe(
      "unclassified",
    );
  });

  it("uses the stored category for a current gated or pending verdict", () => {
    expect(
      deferralReason(
        yt,
        { detected_hosts: yt, status: "gated", category_key: "analytics" },
        classify,
      ),
    ).toBe("analytics");
    expect(
      deferralReason(
        yt,
        { detected_hosts: yt, status: "pending", category_key: "marketing" },
        classify,
      ),
    ).toBe("unclassified");
  });
});
