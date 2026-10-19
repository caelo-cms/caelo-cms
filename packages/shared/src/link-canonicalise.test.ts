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
} from "./link-canonicalise.js";

const ABOUT = "11111111-1111-4111-8111-111111111111";
const HOME = "22222222-2222-4222-8222-222222222222";
const GONE = "33333333-3333-4333-8333-333333333333";
const HERO = "44444444-4444-4444-8444-444444444444";

const lookup: LinkTargetLookup = {
  pageIdForPath: (p) => ({ "/": HOME, "/company/about": ABOUT, "/old-about": ABOUT })[p] ?? null,
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
      "/files/guide.pdf",
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

describe("rollout E — planned pages and scoped runs", () => {
  it("keeps a link to a planned page literal and records it instead of an issue", () => {
    const r = linkCanonicaliseRun({ ...lookup, isPendingPagePath: (p) => p === "/pricing" });
    expect(canonicaliseUrl("/pricing/#plans", r, "values.cta_href")).toBe("/pricing/#plans");
    expect(canonicaliseUrl("/typo", r, "values.other")).toBe("/typo");
    expect(r.pending).toEqual([
      { value: "/pricing/#plans", path: "/pricing", where: "values.cta_href" },
    ]);
    expect(r.issues.map((i) => i.value)).toEqual(["/typo"]);
  });

  it("an `only` run looks at the listed literals and nothing else", () => {
    const r = linkCanonicaliseRun(lookup, { mode: "report", only: new Set(["/company/about"]) });
    const html = '<a href="/company/about">a</a><a href="/">h</a><a href="/nowhere">n</a>';
    expect(canonicaliseHtmlLinks(html, r, "html")).toBe(
      `<a href="caelo:page/${ABOUT}">a</a><a href="/">h</a><a href="/nowhere">n</a>`,
    );
    expect(r.issues).toEqual([]);
  });
});
