// SPDX-License-Identifier: MPL-2.0

/**
 * The plugin's pure URL rules: the bare default locale (unchanged
 * behaviour) and the opt-in `prefixDefaultLocale` shape, where every
 * default-locale page is prefixed except the home, which stays at "/".
 */

import { describe, expect, it } from "bun:test";
import {
  decodeLocalePrefix,
  defaultLocaleRootRedirect,
  encodeLocalePrefix,
  PREFIX_DEFAULT_LOCALE_ANNOTATION,
  prefixDefaultLocaleError,
  type UrlLocale,
} from "./url.js";

const de: UrlLocale = { code: "de", url_strategy: "subdirectory", is_default: true };
const en: UrlLocale = { code: "en", url_strategy: "subdirectory", is_default: false };
const fr: UrlLocale = { code: "fr", url_strategy: "subdomain", is_default: false };
const locales = new Map<string, UrlLocale>([
  ["de", de],
  ["en", en],
  ["fr", fr],
]);

function page(
  locale: UrlLocale,
  opts: { isHomePage?: boolean; prefixDefault?: boolean } = {},
): Parameters<typeof encodeLocalePrefix>[0] {
  return {
    isHomePage: opts.isHomePage ?? false,
    annotations: {
      locale: locale.code,
      isDefaultLocale: locale.is_default,
      urlStrategy: locale.url_strategy,
      ...(opts.prefixDefault ? { [PREFIX_DEFAULT_LOCALE_ANNOTATION]: true } : {}),
    },
  };
}

describe("encodeLocalePrefix — default behaviour (setting off)", () => {
  it("serves the default locale bare, page and home alike", () => {
    expect(encodeLocalePrefix(page(de))).toEqual([]);
    expect(encodeLocalePrefix(page(de, { isHomePage: true }))).toEqual([]);
  });

  it("prefixes a non-default subdirectory locale, its locale root included", () => {
    expect(encodeLocalePrefix(page(en))).toEqual(["en"]);
    expect(encodeLocalePrefix(page(en, { isHomePage: true }))).toEqual(["en"]);
  });

  it("leaves host-strategy locales and annotation-free pages unprefixed", () => {
    expect(encodeLocalePrefix(page(fr))).toEqual([]);
    expect(encodeLocalePrefix({ isHomePage: false, annotations: {} })).toEqual([]);
  });
});

describe("encodeLocalePrefix — prefixDefaultLocale on", () => {
  it("prefixes every default-locale page", () => {
    expect(encodeLocalePrefix(page(de, { prefixDefault: true }))).toEqual(["de"]);
  });

  it("keeps the default-locale home at the bare root — no redirect hop for '/'", () => {
    expect(encodeLocalePrefix(page(de, { isHomePage: true, prefixDefault: true }))).toEqual([]);
  });

  it("does not prefix a default locale that is not on the subdirectory strategy", () => {
    const bareDefault: UrlLocale = { code: "de", url_strategy: "none", is_default: true };
    expect(encodeLocalePrefix(page(bareDefault, { prefixDefault: true }))).toEqual([]);
  });

  it("leaves non-default locales exactly as before", () => {
    expect(encodeLocalePrefix(page(en, { prefixDefault: true }))).toEqual(["en"]);
    expect(encodeLocalePrefix(page(en, { isHomePage: true, prefixDefault: true }))).toEqual(["en"]);
  });
});

describe("decodeLocalePrefix", () => {
  it("treats the default locale code as an ordinary slug while the setting is off", () => {
    expect(decodeLocalePrefix(["de", "preise"], locales, false)).toBeNull();
    expect(decodeLocalePrefix(["en", "pricing"], locales, false)).toEqual({
      consumed: 1,
      annotations: { locale: "en" },
    });
  });

  it("consumes the default locale prefix while the setting is on", () => {
    expect(decodeLocalePrefix(["de", "preise"], locales, true)).toEqual({
      consumed: 1,
      annotations: { locale: "de" },
    });
  });

  it("never consumes host-strategy codes, unknown codes or the bare root", () => {
    expect(decodeLocalePrefix(["fr", "prix"], locales, true)).toBeNull();
    expect(decodeLocalePrefix(["it", "x"], locales, true)).toBeNull();
    expect(decodeLocalePrefix([], locales, true)).toBeNull();
  });
});

describe("prefixDefaultLocaleError", () => {
  const list = (defaultStrategy: UrlLocale["url_strategy"]) => [
    { code: "de", urlStrategy: defaultStrategy, isDefault: true },
    { code: "en", urlStrategy: "subdirectory" as const, isDefault: false },
  ];

  it("accepts the setting off for any registry", () => {
    expect(prefixDefaultLocaleError(false, list("none"))).toBeNull();
  });

  it("accepts the setting on when the default locale uses subdirectories", () => {
    expect(prefixDefaultLocaleError(true, list("subdirectory"))).toBeNull();
  });

  it("refuses the setting on for a default locale without the subdirectory strategy, naming the fix", () => {
    const msg = prefixDefaultLocaleError(true, list("none"));
    expect(msg).toContain('"de"');
    expect(msg).toContain("subdirectory");
    // Omission keeps a stored `true`, so the fix must name the explicit off.
    expect(msg).toContain("prefixDefaultLocale: false");
  });
});

describe("defaultLocaleRootRedirect", () => {
  it("301s the prefixed default root to '/'", () => {
    expect(defaultLocaleRootRedirect("de")).toEqual({
      fromPath: "/de",
      toPath: "/",
      statusCode: 301,
    });
  });
});
