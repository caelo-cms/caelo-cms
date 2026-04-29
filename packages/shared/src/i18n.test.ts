// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  buildHreflangLinks,
  computeContentHash,
  type LocaleConfig,
  lintLocaleConfig,
  resolveLocaleUrl,
} from "./i18n.js";

const ENG: LocaleConfig = {
  code: "en",
  displayName: "English",
  urlStrategy: "none",
  urlHost: null,
  isDefault: true,
};

const DE_SUBDIR: LocaleConfig = {
  code: "de",
  displayName: "Deutsch",
  urlStrategy: "subdirectory",
  urlHost: null,
  isDefault: false,
};

const DE_SUBDOMAIN: LocaleConfig = {
  code: "de",
  displayName: "Deutsch",
  urlStrategy: "subdomain",
  urlHost: "de.example.com",
  isDefault: false,
};

const DE_DOMAIN: LocaleConfig = {
  code: "de",
  displayName: "Deutsch",
  urlStrategy: "domain",
  urlHost: "example.de",
  isDefault: false,
};

describe("resolveLocaleUrl", () => {
  it("strategy=none yields bare slug under siteBaseUrl with trailing slash", () => {
    expect(resolveLocaleUrl(ENG, "about", "https://example.com")).toBe(
      "https://example.com/about/",
    );
  });

  it("strategy=subdirectory prefixes the locale code", () => {
    expect(resolveLocaleUrl(DE_SUBDIR, "about", "https://example.com")).toBe(
      "https://example.com/de/about/",
    );
  });

  it("strategy=subdomain uses urlHost", () => {
    expect(resolveLocaleUrl(DE_SUBDOMAIN, "about", "https://example.com")).toBe(
      "https://de.example.com/about/",
    );
  });

  it("strategy=domain uses urlHost", () => {
    expect(resolveLocaleUrl(DE_DOMAIN, "about", "https://example.com")).toBe(
      "https://example.de/about/",
    );
  });

  it("strategy=subdomain throws when urlHost missing", () => {
    expect(() =>
      resolveLocaleUrl({ ...DE_SUBDOMAIN, urlHost: null }, "about", "https://example.com"),
    ).toThrow(/url_host/);
  });

  it("trailing slashes on baseUrl are normalised", () => {
    expect(resolveLocaleUrl(ENG, "about", "https://example.com//")).toBe(
      "https://example.com/about/",
    );
  });

  it("leading slashes on slug are stripped", () => {
    expect(resolveLocaleUrl(ENG, "/about", "https://example.com")).toBe(
      "https://example.com/about/",
    );
  });

  it("home slug renders as the locale root (no extra path segment)", () => {
    expect(resolveLocaleUrl(ENG, "home", "https://example.com")).toBe("https://example.com/");
    expect(resolveLocaleUrl(DE_SUBDIR, "home", "https://example.com")).toBe(
      "https://example.com/de/",
    );
    expect(resolveLocaleUrl(DE_SUBDOMAIN, "home", "https://example.com")).toBe(
      "https://de.example.com/",
    );
  });
});

// renderLanguageSelector lives in structured-sets.ts but exercises the
// same i18n primitives (resolveLocaleUrl produces hrefs the test feeds
// in pre-resolved). Cover the three paths: vanilla render, override
// relabel, hidden locale.
import { renderLanguageSelector } from "./structured-sets.js";

describe("renderLanguageSelector", () => {
  const ENGLISH = {
    code: "en",
    displayName: "English",
    href: "https://example.com/about/",
    isCurrent: true,
  };
  const GERMAN = {
    code: "de",
    displayName: "Deutsch",
    href: "https://example.com/de/about/",
    isCurrent: false,
  };

  it("emits one anchor per locale + aria-current on the current page", () => {
    const html = renderLanguageSelector({ availableLocales: [ENGLISH, GERMAN] });
    expect(html).toContain('hreflang="en"');
    expect(html).toContain('hreflang="de"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("English");
    expect(html).toContain("Deutsch");
  });

  it("override relabels a locale", () => {
    const html = renderLanguageSelector({
      availableLocales: [ENGLISH, GERMAN],
      overrides: [{ locale: "de", label: "DE 🇩🇪" }],
    });
    expect(html).toContain("DE 🇩🇪");
    expect(html).not.toContain("Deutsch");
  });

  it("hidden override drops the locale entirely", () => {
    const html = renderLanguageSelector({
      availableLocales: [ENGLISH, GERMAN],
      overrides: [{ locale: "de", hidden: true }],
    });
    expect(html).toContain('hreflang="en"');
    expect(html).not.toContain('hreflang="de"');
  });

  it("empty available list returns empty string", () => {
    expect(renderLanguageSelector({ availableLocales: [] })).toBe("");
  });

  it("escapes attribute special chars", () => {
    const html = renderLanguageSelector({
      availableLocales: [{ code: "en", displayName: "EN&Co", href: "/?a=1&b=2", isCurrent: false }],
    });
    expect(html).toContain("a=1&amp;b=2");
    expect(html).toContain("EN&amp;Co");
  });
});

describe("buildHreflangLinks", () => {
  it("emits one link per locale + x-default for the default", () => {
    const html = buildHreflangLinks([
      { localeCode: "en", url: "https://example.com/about", isDefault: true },
      { localeCode: "de", url: "https://example.com/de/about", isDefault: false },
    ]);
    expect(html).toContain('hreflang="en"');
    expect(html).toContain('hreflang="de"');
    expect(html).toContain('hreflang="x-default"');
    expect(html).toContain('href="https://example.com/about"');
  });

  it("returns empty string when no entries", () => {
    expect(buildHreflangLinks([])).toBe("");
  });

  it("escapes attribute special characters", () => {
    const html = buildHreflangLinks([
      { localeCode: "en", url: "https://example.com/?a=1&b=2", isDefault: true },
    ]);
    expect(html).toContain("a=1&amp;b=2");
  });
});

describe("computeContentHash", () => {
  it("is stable across runs for the same input", async () => {
    const a = await computeContentHash({ x: 1, y: [1, 2] });
    const b = await computeContentHash({ x: 1, y: [1, 2] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is order-independent for object keys", async () => {
    const a = await computeContentHash({ x: 1, y: 2 });
    const b = await computeContentHash({ y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it("is order-dependent for arrays", async () => {
    const a = await computeContentHash({ x: [1, 2] });
    const b = await computeContentHash({ x: [2, 1] });
    expect(a).not.toBe(b);
  });
});

describe("lintLocaleConfig", () => {
  it("warns when subdomain/domain used while advanced toggle is off", () => {
    const warnings = lintLocaleConfig([ENG, DE_SUBDOMAIN], false);
    expect(warnings.find((w) => w.code === "advanced-routing-disabled")).toBeTruthy();
  });

  it("does not warn when toggle matches usage", () => {
    const warnings = lintLocaleConfig([ENG, DE_SUBDOMAIN], true);
    expect(warnings.find((w) => w.code === "advanced-routing-disabled")).toBeFalsy();
  });

  it("warns when subdomain locale lacks urlHost", () => {
    const broken: LocaleConfig = { ...DE_SUBDOMAIN, urlHost: null };
    const warnings = lintLocaleConfig([ENG, broken], true);
    expect(warnings.find((w) => w.code === "missing-url-host")).toBeTruthy();
  });

  it("warns about mixed default-none + subdir-sibling configs", () => {
    const warnings = lintLocaleConfig([ENG, DE_SUBDIR], true);
    expect(warnings.find((w) => w.code === "mixed-default-none-subdir")).toBeTruthy();
  });
});
