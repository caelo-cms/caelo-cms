// SPDX-License-Identifier: MPL-2.0

/**
 * #390 — URL composition point, pure half: grammar-ordered composition
 * across two contributing plugins (path-prefix + slug-format), decode
 * inversion, exclusive-slot conflicts (incl. full-path), and loud
 * failures on invalid segments. No DB.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { UrlContributionDef } from "@caelo-cms/plugin-sdk";
import { decodePagePath, resolvePageUrl, urlContributionsRegistry } from "./url-composition.js";

afterEach(() => {
  urlContributionsRegistry.reset();
});

const KNOWN_LOCALES = new Set(["de", "fr"]);

const localePrefix: UrlContributionDef = {
  slot: "path-prefix",
  encode: (page) => {
    const locale = page.annotations.locale;
    if (typeof locale !== "string") return [];
    return locale === "en" ? [] : [locale];
  },
  decode: (segments) => {
    const head = segments[0];
    if (head !== undefined && KNOWN_LOCALES.has(head)) {
      return { consumed: 1, annotations: { locale: head } };
    }
    return null;
  },
};

const dashSlugFormat: UrlContributionDef = {
  slot: "slug-format",
  encode: (page) => page.slug.replace(/\//g, "-"),
  decode: (urlSlug) => urlSlug.replace(/-/g, "/"),
};

function page(slug: string, annotations: Record<string, unknown> = {}, isHomePage = false) {
  return { pageId: "00000000-0000-4000-8000-000000000001", slug, isHomePage, annotations };
}

describe("#390 — composition grammar", () => {
  it("no contributions: '/<slug>' and '/' for the designated root", () => {
    expect(resolvePageUrl(page("pricing")).path).toBe("/pricing");
    expect(resolvePageUrl(page("welcome", {}, true)).path).toBe("/");
  });

  it("two plugins compose in grammar order, not registration order", () => {
    // Register the slug-format FIRST — the prefix must still lead.
    urlContributionsRegistry.register("dasher", [dashSlugFormat]);
    urlContributionsRegistry.register("intl", [localePrefix]);
    const r = resolvePageUrl(page("blog/first-post", { locale: "de" }));
    expect(r.path).toBe("/de/blog-first-post");
    // Default variant stays bare.
    expect(resolvePageUrl(page("blog/first-post", { locale: "en" })).path).toBe("/blog-first-post");
  });

  it("the designated root serves at the prefix root", () => {
    urlContributionsRegistry.register("intl", [localePrefix]);
    expect(resolvePageUrl(page("welcome", { locale: "en" }, true)).path).toBe("/");
    expect(resolvePageUrl(page("willkommen", { locale: "de" }, true)).path).toBe("/de");
  });

  it("decode inverts the two-plugin composition", () => {
    urlContributionsRegistry.register("intl", [localePrefix]);
    urlContributionsRegistry.register("dasher", [dashSlugFormat]);
    const d = decodePagePath("/de/blog-first-post");
    expect(d.slug).toBe("blog/first/post");
    expect(d.annotations).toEqual({ locale: "de" });
    const root = decodePagePath("/de");
    expect(root.slug).toBeNull();
    expect(root.annotations).toEqual({ locale: "de" });
    expect(decodePagePath("/").slug).toBeNull();
  });

  it("host contribution rides along without touching the path", () => {
    urlContributionsRegistry.register("intl", [
      localePrefix,
      {
        slot: "host",
        encode: (p) => (p.annotations.locale === "de" ? "de.example.com" : null),
        decode: (host) => (host === "de.example.com" ? { annotations: { locale: "de" } } : null),
      },
    ]);
    const r = resolvePageUrl(page("pricing", { locale: "de" }));
    expect(r.host).toBe("de.example.com");
    expect(r.path).toBe("/de/pricing");
    expect(resolvePageUrl(page("pricing", { locale: "en" })).host).toBeNull();
  });

  it("invalid produced segments fail loudly", () => {
    urlContributionsRegistry.register("evil", [
      {
        slot: "path-prefix",
        encode: () => ["../escape"],
        decode: () => null,
      },
    ]);
    expect(() => resolvePageUrl(page("pricing"))).toThrow(/invalid path segment/);
  });
});

describe("#390 — exclusive slots", () => {
  it("second claimant of a slot fails naming the holder", () => {
    urlContributionsRegistry.register("international-site", [localePrefix]);
    expect(() => urlContributionsRegistry.register("other-plugin", [localePrefix])).toThrow(
      /already claimed by plugin "international-site".*conflicts with "other-plugin"/,
    );
  });

  it("full-path excludes every other slot (both directions)", () => {
    const fullPath: UrlContributionDef = {
      slot: "full-path",
      encode: (p) => `/x/${p.slug}`,
      decode: (path) => {
        const m = /^\/x\/(.+)$/.exec(path);
        return m?.[1] ? { slug: m[1], annotations: {} } : null;
      },
    };
    urlContributionsRegistry.register("flat", [fullPath]);
    expect(() => urlContributionsRegistry.register("intl", [localePrefix])).toThrow(
      /cannot be claimed while "flat" holds "full-path"/,
    );
    urlContributionsRegistry.reset();
    urlContributionsRegistry.register("intl", [localePrefix]);
    expect(() => urlContributionsRegistry.register("flat", [fullPath])).toThrow(/exclusive/);
  });

  it("full-path owns compose AND decode; unknown paths are loud", () => {
    urlContributionsRegistry.register("flat", [
      {
        slot: "full-path",
        encode: (p) => `/x/${p.slug}`,
        decode: (path) => {
          const m = /^\/x\/(.+)$/.exec(path);
          return m?.[1] ? { slug: m[1], annotations: {} } : null;
        },
      },
    ]);
    expect(resolvePageUrl(page("pricing")).path).toBe("/x/pricing");
    expect(decodePagePath("/x/pricing").slug).toBe("pricing");
    expect(() => decodePagePath("/unknown")).toThrow(/cannot decode/);
  });
});
