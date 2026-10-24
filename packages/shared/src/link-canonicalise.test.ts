// SPDX-License-Identifier: MPL-2.0

/**
 * Tier-1 unit tests for write-time link canonicalisation (epic #724,
 * rollout C): which positions are links, what becomes a reference, what
 * stays literal, and what is an issue.
 */

import { describe, expect, it } from "bun:test";
import {
  canonicaliseContentValues,
  canonicaliseFieldDefaults,
  canonicaliseHtmlLinks,
  canonicaliseJsonLinks,
  canonicaliseUrl,
  collectLinkLiterals,
  describeLinkIssues,
  type LinkTargetLookup,
  linkCanonicaliseRun,
  urlFieldNamesInHtml,
} from "./link-canonicalise.js";

const ABOUT = "11111111-1111-4111-8111-111111111111";
const HOME = "22222222-2222-4222-8222-222222222222";
const GONE = "33333333-3333-4333-8333-333333333333";
const HERO = "44444444-4444-4444-8444-444444444444";

const lookup: LinkTargetLookup = {
  pageIdForPath: (p) =>
    (
      ({
        "/": HOME,
        "/company/about": ABOUT,
        "/old-about": ABOUT,
        // Old URLs an import redirected (301) to the page.
        "/about.html": ABOUT,
        "/about/index.html": ABOUT,
      }) as Record<string, string>
    )[p] ?? null,
  mediaIdForSlug: (s) => (s === "hero" ? HERO : null),
  pageExists: (id) => id === ABOUT || id === HOME,
  mediaExists: (id) => id === HERO,
  isOwnHost: (h) => h === "example.com",
};

const run = (grandfathered: string[] = []) =>
  linkCanonicaliseRun(lookup, { grandfathered: new Set(grandfathered) });

describe("canonicaliseUrl", () => {
  it("turns internal paths, own-domain URLs and media URLs into references", () => {
    const r = run();
    expect(canonicaliseUrl("/company/about", r, "x")).toBe(`caelo:page/${ABOUT}`);
    expect(canonicaliseUrl("/company/about/#team", r, "x")).toBe(`caelo:page/${ABOUT}#team`);
    expect(canonicaliseUrl("/company/about?ref=nav", r, "x")).toBe(`caelo:page/${ABOUT}?ref=nav`);
    expect(canonicaliseUrl("/", r, "x")).toBe(`caelo:page/${HOME}`);
    expect(canonicaliseUrl("https://example.com/company/about", r, "x")).toBe(
      `caelo:page/${ABOUT}`,
    );
    expect(canonicaliseUrl("/old-about", r, "x")).toBe(`caelo:page/${ABOUT}`);
    expect(canonicaliseUrl("/_caelo/media/hero", r, "x")).toBe(`caelo:media/${HERO}`);
    expect(canonicaliseUrl("/_caelo/media/hero/webp-800", r, "x")).toBe(
      `caelo:media/${HERO}/webp-800`,
    );
    expect(canonicaliseUrl(`/_caelo/media/${HERO}/webp-400`, r, "x")).toBe(
      `caelo:media/${HERO}/webp-400`,
    );
    expect(r.issues).toEqual([]);
  });

  it("leaves external, special and non-page URLs literal", () => {
    const r = run();
    for (const v of [
      "https://other.org/about",
      "//cdn.example.com/x.js",
      "mailto:hi@example.com",
      "tel:+491234",
      "#pricing",
      "{{cta_href}}",
      "/robots.txt",
      "/sitemap.xml",
      "/_assets/app.css",
      "/api/forms/contact",
      "relative/path",
      "",
    ]) {
      expect(canonicaliseUrl(v, r, "x")).toBe(v);
    }
    expect(r.issues).toEqual([]);
  });

  it("reports unknown paths, unknown media and dangling references", () => {
    const r = run();
    expect(canonicaliseUrl("/nope", r, "values.cta_href")).toBe("/nope");
    expect(canonicaliseUrl("/_caelo/media/missing", r, "html")).toBe("/_caelo/media/missing");
    expect(canonicaliseUrl(`caelo:page/${GONE}`, r, "items[0].href")).toBe(`caelo:page/${GONE}`);
    expect(canonicaliseUrl(`caelo:page/${ABOUT}`, r, "ok")).toBe(`caelo:page/${ABOUT}`);
    expect(r.issues.map((i) => [i.kind, i.value, i.where])).toEqual([
      ["unknown-page-path", "/nope", "values.cta_href"],
      ["unknown-media", "/_caelo/media/missing", "html"],
      ["dangling-page-ref", `caelo:page/${GONE}`, "items[0].href"],
    ]);
  });

  it("resolves file-shaped old URLs a page or redirect answers before treating them as files", () => {
    const r = run();
    expect(canonicaliseUrl("/about.html", r, "x")).toBe(`caelo:page/${ABOUT}`);
    expect(canonicaliseUrl("/about/index.html#team", r, "x")).toBe(`caelo:page/${ABOUT}#team`);
    expect(r.issues).toEqual([]);
  });

  it("reports a file path nothing serves (strict) and keeps it literal (report)", () => {
    const strict = run();
    expect(canonicaliseUrl("/files/guide.pdf", strict, "html")).toBe("/files/guide.pdf");
    expect(canonicaliseUrl("/index.php", strict, "html")).toBe("/index.php");
    expect(strict.issues.map((i) => [i.kind, i.value])).toEqual([
      ["unknown-file", "/files/guide.pdf"],
      ["unknown-file", "/index.php"],
    ]);
    const report = linkCanonicaliseRun(lookup, { mode: "report" });
    expect(canonicaliseUrl("/files/guide.pdf", report, "html")).toBe("/files/guide.pdf");
    expect(report.issues.map((i) => i.kind)).toEqual(["unknown-file"]);
    expect(describeLinkIssues(strict.issues)).toContain("media library");
  });

  it("refuses a media link with a query or anchor instead of dropping it", () => {
    const r = run();
    expect(canonicaliseUrl("/_caelo/media/hero#page=3", r, "x")).toBe("/_caelo/media/hero#page=3");
    expect(canonicaliseUrl("/_caelo/media/hero?download=1", r, "y")).toBe(
      "/_caelo/media/hero?download=1",
    );
    expect(r.issues.map((i) => [i.kind, i.where])).toEqual([
      ["unsupported-link-form", "x"],
      ["unsupported-link-form", "y"],
    ]);
    const report = linkCanonicaliseRun(lookup, { mode: "report" });
    expect(canonicaliseUrl("/_caelo/media/hero#page=3", report, "x")).toBe(
      "/_caelo/media/hero#page=3",
    );
    expect(report.issues.map((i) => i.kind)).toEqual(["unsupported-link-form"]);
  });

  it("stores the orig variant as the plain media reference", () => {
    const r = run();
    expect(canonicaliseUrl("/_caelo/media/hero/orig", r, "x")).toBe(`caelo:media/${HERO}`);
    expect(canonicaliseUrl(`/_caelo/media/${HERO}/orig`, r, "x")).toBe(`caelo:media/${HERO}`);
    expect(r.issues).toEqual([]);
  });

  it("grandfathers links already stored", () => {
    const r = run(["/nope", `caelo:page/${GONE}`]);
    canonicaliseUrl("/nope", r, "x");
    canonicaliseUrl(`caelo:page/${GONE}`, r, "x");
    expect(r.issues).toEqual([]);
  });

  it("restricts media positions to media", () => {
    const r = run();
    expect(canonicaliseUrl("/company/about", r, "x", "media")).toBe("/company/about");
    expect(r.issues).toEqual([]);
  });

  it("keeps a link to a planned page literal and pending, never an issue", () => {
    const planned = new Set(["/later", "/old/page.html"]);
    const r = linkCanonicaliseRun({ ...lookup, isPendingPagePath: (p) => planned.has(p) });
    expect(canonicaliseUrl("/later/#x", r, "values.cta_href")).toBe("/later/#x");
    expect(canonicaliseUrl("https://example.com/old/page.html", r, "html")).toBe(
      "https://example.com/old/page.html",
    );
    // An existing page still resolves; an unplanned path is still an issue.
    expect(canonicaliseUrl("/company/about", r, "x")).toBe(`caelo:page/${ABOUT}`);
    expect(canonicaliseUrl("/typo", r, "y")).toBe("/typo");
    expect(r.pending).toEqual([
      { value: "/later/#x", path: "/later", where: "values.cta_href" },
      { value: "https://example.com/old/page.html", path: "/old/page.html", where: "html" },
    ]);
    expect(r.issues.map((i) => [i.kind, i.value])).toEqual([["unknown-page-path", "/typo"]]);
    // Without an import run nothing is pending.
    const strict = run();
    canonicaliseUrl("/later", strict, "x");
    expect(strict.pending).toEqual([]);
    expect(strict.issues.map((i) => i.kind)).toEqual(["unknown-page-path"]);
  });

  // e2e-livedit detected bugs: the site header (brand link "/", nav
  // "/#features") is built before the homepage exists and was refused.
  it("keeps the site root literal while no page serves it, never an issue", () => {
    const noRoot: LinkTargetLookup = {
      ...lookup,
      pageIdForPath: (p) => (p === "/" ? null : lookup.pageIdForPath(p)),
    };
    const r = linkCanonicaliseRun(noRoot);
    expect(canonicaliseUrl("/", r, "html")).toBe("/");
    expect(canonicaliseUrl("/#features", r, "fields.nav.default[1].href")).toBe("/#features");
    expect(canonicaliseUrl("https://example.com/?ref=nav", r, "x")).toBe(
      "https://example.com/?ref=nav",
    );
    expect(canonicaliseHtmlLinks('<a href="/">Home</a><a href="/#features">F</a>', r, "html")).toBe(
      '<a href="/">Home</a><a href="/#features">F</a>',
    );
    expect(r.issues).toEqual([]);
    // A suffix the stored grammar cannot carry is still refused, and any
    // other unknown path still is an issue: only the root is guaranteed.
    canonicaliseUrl('/#bad"anchor', r, "y");
    canonicaliseUrl("/get-started", r, "z");
    expect(r.issues.map((i) => [i.kind, i.value])).toEqual([
      ["unsupported-link-form", '/#bad"anchor'],
      ["unknown-page-path", "/get-started"],
    ]);
    // Once the homepage exists the root becomes its reference as usual.
    expect(canonicaliseUrl("/#features", run(), "x")).toBe(`caelo:page/${HOME}#features`);
  });

  it("reports a malformed reference instead of passing it through", () => {
    const r = run();
    const bad = [
      "caelo:page/1111", // truncated id
      `caelo:page/${ABOUT}/team`, // stray path after the id
      "caelo:page/ABCDEF01-1111-4111-8111-111111111111", // ids are lowercase
      `caelo:media/${HERO}/WEBP`, // variant outside the grammar
    ];
    for (const v of bad) expect(canonicaliseUrl(v, r, "values.cta_href")).toBe(v);
    expect(r.issues.map((i) => [i.kind, i.value])).toEqual(
      bad.map((v) => ["malformed-link-ref", v]),
    );
    expect(describeLinkIssues(r.issues)).toContain("write the page's path");
    // Grandfathered like any other stored literal.
    const g = run(["caelo:page/1111"]);
    canonicaliseUrl("caelo:page/1111", g, "x");
    expect(g.issues).toEqual([]);
  });

  it("turns a query or anchor outside the grammar into an issue, never a throw", () => {
    // `formatLinkRef` throws on a suffix it cannot parse back; the
    // canonicaliser must validate with the grammar's own patterns first.
    const r = run();
    for (const v of [
      "/company/about#a b",
      "/company/about#x#y",
      "/company/about?a=1?b=2",
      '/company/about?q="x"',
      `/company/about#${"a".repeat(257)}`,
      `/company/about?${"q".repeat(513)}`,
      "/company/about#über",
    ]) {
      expect(() => canonicaliseUrl(v, r, "x")).not.toThrow();
      expect(canonicaliseUrl(v, run(), "x")).toBe(v);
    }
    expect(r.issues.every((i) => i.kind === "unsupported-link-form")).toBe(true);
    expect(r.issues).toHaveLength(7);
    // The longest suffixes the grammar allows still become references.
    const ok = run();
    const anchor = "a".repeat(256);
    expect(canonicaliseUrl(`/company/about#${anchor}`, ok, "x")).toBe(
      `caelo:page/${ABOUT}#${anchor}`,
    );
    expect(ok.issues).toEqual([]);
  });
});

describe("HTML and JSON positions", () => {
  it("canonicalises href, src, srcset and poster in HTML", () => {
    const r = run();
    const html =
      `<a class="b" href="/company/about#x">A</a><a href='https://other.org/'>O</a>` +
      `<img src="/_caelo/media/hero" srcset="/_caelo/media/hero/webp-400 400w, /_caelo/media/hero/webp-800 800w">` +
      `<img data-src="/company/about" src="/company/about"><a href="{{href}}">t</a>`;
    expect(canonicaliseHtmlLinks(html, r, "html")).toBe(
      `<a class="b" href="caelo:page/${ABOUT}#x">A</a><a href='https://other.org/'>O</a>` +
        `<img src="caelo:media/${HERO}" srcset="caelo:media/${HERO}/webp-400 400w, caelo:media/${HERO}/webp-800 800w">` +
        `<img data-src="/company/about" src="/company/about"><a href="{{href}}">t</a>`,
    );
    expect(r.issues).toEqual([]);
  });

  it("reads attributes only inside start tags, not in escaped code samples", () => {
    const r = run();
    const html =
      '<pre><code>&lt;a href="/nope"&gt;Docs&lt;/a&gt;</code></pre>' +
      `<a title="a > b" href="/company/about">x</a><img alt='it"s' src="/_caelo/media/hero">`;
    expect(canonicaliseHtmlLinks(html, r, "html")).toBe(
      '<pre><code>&lt;a href="/nope"&gt;Docs&lt;/a&gt;</code></pre>' +
        `<a title="a > b" href="caelo:page/${ABOUT}">x</a><img alt='it"s' src="caelo:media/${HERO}">`,
    );
    expect(r.issues).toEqual([]);
    // An unterminated quote does not hide the tags before it.
    expect(canonicaliseHtmlLinks('<a href="/company/about">x</a><b title="oops>', run(), "h")).toBe(
      `<a href="caelo:page/${ABOUT}">x</a><b title="oops>`,
    );
  });

  it("reports malformed references in any HTML link position, once each", () => {
    const r = run();
    const html =
      `<a href="caelo:page/${ABOUT}/team">A</a>` +
      `<div data-href="caelo:page/1234">B</div>` +
      `<img srcset="caelo:media/${HERO} 1x, caelo:media/abc 2x">` +
      `<a href="caelo:page/${ABOUT}#ok">C</a>` +
      "<p>Write caelo:page/&lt;id&gt; in prose: not a link.</p>";
    expect(canonicaliseHtmlLinks(html, r, "html")).toBe(html);
    expect(r.issues.map((i) => [i.kind, i.value])).toEqual([
      ["malformed-link-ref", `caelo:page/${ABOUT}/team`],
      ["malformed-link-ref", "caelo:media/abc"],
      ["malformed-link-ref", "caelo:page/1234"],
    ]);
    // HTML without any attribute is still checked (a value that starts
    // with the broken reference); element text is not a link position.
    const t = run();
    canonicaliseHtmlLinks("caelo:page/1234 <b>caelo:page/5678</b>", t, "html");
    expect(t.issues.map((i) => i.value)).toEqual(["caelo:page/1234"]);
  });

  it("reports a malformed reference in a plain text value", () => {
    const r = run();
    expect(canonicaliseJsonLinks({ label: "caelo:page/1234" }, r, "values")).toEqual({
      label: "caelo:page/1234",
    });
    expect(r.issues.map((i) => [i.kind, i.where])).toEqual([
      ["malformed-link-ref", "values.label"],
    ]);
    // A stored malformed value is grandfathered by the next write.
    const g = linkCanonicaliseRun(lookup, {
      grandfathered: collectLinkLiterals({ label: "caelo:page/1234" }),
    });
    canonicaliseJsonLinks({ label: "caelo:page/1234" }, g, "values");
    expect(g.issues).toEqual([]);
  });

  it("treats link-named keys as URLs and plain text as text", () => {
    const r = run();
    const items = [
      { label: "About", href: "/company/about", children: [{ label: "Home", href: "/" }] },
      { label: "/month", note: "/month" },
    ];
    expect(canonicaliseJsonLinks(items, r, "items")).toEqual([
      {
        label: "About",
        href: `caelo:page/${ABOUT}`,
        children: [{ label: "Home", href: `caelo:page/${HOME}` }],
      },
      { label: "/month", note: "/month" },
    ]);
    expect(r.issues).toEqual([]);
  });

  it("canonicalises content values by field kind and name", () => {
    const r = run();
    const out = canonicaliseContentValues(
      [
        { name: "cta", kind: "url" },
        { name: "hero", kind: "image" },
        { name: "price_suffix", kind: "text" },
        { name: "nav", kind: "link-list" },
        { name: "body", kind: "richtext" },
        { name: "card", kind: "module" },
      ],
      {
        cta: "/company/about",
        hero: "/_caelo/media/hero",
        price_suffix: "/month",
        nav: [{ label: "Home", href: "/" }],
        body: '<p><a href="/company/about">us</a></p>',
        card: { moduleId: ABOUT, contentInstanceId: HOME },
        legacy_href: "/company/about",
      },
      r,
    );
    expect(out).toEqual({
      cta: `caelo:page/${ABOUT}`,
      hero: `caelo:media/${HERO}`,
      price_suffix: "/month",
      nav: [{ label: "Home", href: `caelo:page/${HOME}` }],
      body: `<p><a href="caelo:page/${ABOUT}">us</a></p>`,
      card: { moduleId: ABOUT, contentInstanceId: HOME },
      legacy_href: `caelo:page/${ABOUT}`,
    });
    expect(r.issues).toEqual([]);
  });

  it("canonicalises field defaults (layout chrome)", () => {
    const r = run();
    const fields = canonicaliseFieldDefaults(
      [
        {
          name: "links",
          kind: "link-list",
          label: "L",
          default: [{ label: "A", href: "/company/about" }],
        },
        { name: "title", kind: "text", label: "T", default: "/company/about" },
      ],
      r,
    );
    expect(fields[0]?.default).toEqual([{ label: "A", href: `caelo:page/${ABOUT}` }]);
    expect(fields[1]?.default).toBe("/company/about");
  });
});

describe("grandfathering + messages", () => {
  it("collects every link literal from a stored state", () => {
    const literals = collectLinkLiterals({
      html: '<a href="/nope">x</a>',
      values: { cta: "/gone", text: "hello" },
    });
    expect(literals.has("/nope")).toBe(true);
    expect(literals.has("/gone")).toBe(true);
    expect(literals.has("hello")).toBe(false);
  });

  it("names the value, the place and the next step", () => {
    const msg = describeLinkIssues([
      { kind: "unknown-page-path", value: "/pricing", where: "values.cta_href" },
    ]);
    expect(msg).toContain('values.cta_href: "/pricing" is not the path of any page on this site');
    expect(msg).toContain("list_pages");
    expect(msg).toContain("create it first");
  });
});

describe("urlFieldNamesInHtml (#852)", () => {
  it("names fields put whole into href/src, in sections too, and skips partial values", () => {
    const names = urlFieldNamesInHtml(
      '<a href="{{Target}}">{{label}}</a><img src="{{{photo}}}" alt="">' +
        "<ul>{{#links}}<li><a href='{{.}}'>x</a></li>{{/links}}</ul>" +
        '{{#cta}}<a href=" {{cta}} ">go</a>{{/cta}}' +
        '<a href="{{base}}/docs">part</a><a href="mailto:{{email}}">m</a>' +
        '<img srcset="{{set}}" alt="">',
    );
    expect([...names].sort()).toEqual(["cta", "links", "photo", "target"]);
  });

  it("returns nothing for HTML without placeholders", () => {
    expect(urlFieldNamesInHtml('<a href="/about">x</a>').size).toBe(0);
  });

  it("ignores links inside comments and script or style text", () => {
    const names = urlFieldNamesInHtml(
      '<!-- <a href="{{caption}}">old</a> --><p>{{caption}}</p>' +
        "<script>const t = '<a href=\"{{label}}\">x</a>';</script>" +
        '<style>/* <img src="{{photo}}"> */</style><a href="{{target}}">go</a>',
    );
    expect([...names]).toEqual(["target"]);
  });
});
