// SPDX-License-Identifier: MPL-2.0

/**
 * The plugin's Stage-audit rules over the plugin's data and the facts
 * core extracts from the staged pages. The footer case is the reason the
 * rules exist: a footer that links "English" to a fixed `/en/` instead of
 * the `language_links` list source shows a dead link on every page
 * without an English version.
 */

import { describe, expect, it } from "bun:test";
import type { PluginAuditFinding, PluginAuditPageFacts } from "@caelo-cms/plugin-sdk";
import {
  type AuditState,
  BuildModel,
  FACT_BATCH_PAGES,
  factBatchesOf,
  hreflangProblem,
  pageFindings,
  siteFindings,
} from "./audit-rules.js";
import type { LocaleRow, PageVariantRow } from "./index.js";

const FOOTER = "11111111-1111-4111-8111-111111111111";
const HERO = "22222222-2222-4222-8222-222222222222";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HOME_DE = id(1);
const HOME_EN = id(2);
const PRICES_DE = id(3);
const PRICES_EN = id(4);
const TEAM_DE = id(5);

const de: LocaleRow = {
  id: "l-de",
  code: "de",
  display_name: "Deutsch",
  url_strategy: "subdirectory",
  url_host: null,
  is_default: true,
};
const en: LocaleRow = { ...de, id: "l-en", code: "en", display_name: "English", is_default: false };

function variant(
  pageId: string,
  group: string,
  locale: string,
  status: PageVariantRow["translation_status"],
): PageVariantRow {
  return {
    id: `v-${pageId}`,
    group_id: group,
    page_id: pageId,
    locale_code: locale,
    translation_status: status,
    source_event_cursor: null,
  };
}

function state(overrides: Partial<AuditState> = {}): AuditState {
  return {
    locales: new Map([
      ["de", de],
      ["en", en],
    ]),
    variants: [
      variant(HOME_DE, "g-home", "de", "source"),
      variant(HOME_EN, "g-home", "en", "up_to_date"),
      variant(PRICES_DE, "g-prices", "de", "source"),
      variant(PRICES_EN, "g-prices", "en", "up_to_date"),
    ],
    stagedPages: [
      { pageId: HOME_DE, path: "/" },
      { pageId: HOME_EN, path: "/en" },
      { pageId: PRICES_DE, path: "/preise" },
      { pageId: PRICES_EN, path: "/en/pricing" },
      { pageId: TEAM_DE, path: "/team" },
    ],
    siteHomePageId: HOME_DE,
    glossary: [],
    chromeModuleIds: new Set([FOOTER]),
    staleChrome: [],
    ...overrides,
  };
}

const BASE = "https://example.com";

/** Correct head signals for a page of the fixture's groups. */
function facts(
  pageId: string,
  path: string,
  lang: string,
  extra: Partial<PluginAuditPageFacts> = {},
): PluginAuditPageFacts {
  const groups: Record<string, [string, string][]> = {
    "/": [
      ["de", "/"],
      ["en", "/en"],
    ],
    "/en": [
      ["de", "/"],
      ["en", "/en"],
    ],
    "/preise": [
      ["de", "/preise"],
      ["en", "/en/pricing"],
    ],
    "/en/pricing": [
      ["de", "/preise"],
      ["en", "/en/pricing"],
    ],
  };
  const pairs = groups[path] ?? [];
  const alternates = pairs.length
    ? [
        ...pairs.map(([h, p]) => ({ hreflang: h, href: `${BASE}${p}`, path: p })),
        { hreflang: "x-default", href: `${BASE}${pairs[0]?.[1]}`, path: pairs[0]?.[1] ?? null },
      ]
    : [];
  return {
    pageId,
    path,
    lang,
    title: `${path} title`,
    metaDescription: `${path} description`,
    canonical: { href: `${BASE}${path}`, path },
    robots: null,
    ogLocale: null,
    ogLocaleAlternates: [],
    alternates,
    sitemapAlternates: "no-sitemap",
    links: [],
    texts: [],
    truncated: false,
    ...extra,
  };
}

/** The fixed footer link the operator saw: "English" → /en/ on every page. */
const FIXED_ENGLISH = {
  href: "/en/",
  path: "/en",
  hreflang: null,
  text: "English",
  moduleId: FOOTER,
  listItem: null,
  pluginSlug: null,
};

const rulesOf = (found: readonly PluginAuditFinding[]) => found.map((f) => [f.rule, f.pageId]);

describe("language links", () => {
  it("a fixed footer link to /en/ is a hardcoded language link where the page has no English version", () => {
    const model = new BuildModel(state());
    const found = pageFindings(model, [
      facts(HOME_DE, "/", "de", { links: [FIXED_ENGLISH] }),
      facts(HOME_EN, "/en", "en"),
      facts(PRICES_DE, "/preise", "de", { links: [FIXED_ENGLISH] }),
      facts(PRICES_EN, "/en/pricing", "en"),
      facts(TEAM_DE, "/team", "de", { links: [FIXED_ENGLISH] }),
    ]);
    const hardcoded = found.filter((f) => f.rule === "hardcoded-language-link");
    // Site-wide, one message for the module: core files it once.
    expect(new Set(hardcoded.map((f) => f.message)).size).toBe(1);
    expect(hardcoded[0]?.pageId).toBeUndefined();
    expect(hardcoded[0]?.severity).toBe("error");
    expect(hardcoded[0]?.message).toContain(`module ${FOOTER}`);
    expect(hardcoded[0]?.fix?.hint).toContain("{{#language_links}}");
    // Where the page HAS an English version, the same link drops visitors on the home page.
    expect(found.some((f) => f.rule === "switcher-to-home")).toBe(true);
    // The home page's link IS its English version: nothing to say there.
    expect(found.filter((f) => f.pageId === HOME_DE)).toEqual([]);
    // /preise offers no way to /en/pricing.
    expect(found.some((f) => f.rule === "switcher-missing")).toBe(true);
  });

  it("a switch built from language_links (each page's own versions) raises nothing", () => {
    const model = new BuildModel(state());
    const to = (path: string, locale: string, text: string) => ({
      ...FIXED_ENGLISH,
      href: path,
      path,
      hreflang: locale,
      text,
    });
    const found = pageFindings(model, [
      facts(PRICES_DE, "/preise", "de", { links: [to("/en/pricing", "en", "English")] }),
      facts(PRICES_EN, "/en/pricing", "en", { links: [to("/preise", "de", "Deutsch")] }),
      facts(TEAM_DE, "/team", "de"),
    ]);
    expect(found).toEqual([]);
  });

  it("a content link into the other language is a warning when this language has the page", () => {
    const model = new BuildModel(state());
    const found = pageFindings(model, [
      facts(HOME_EN, "/en", "en", {
        links: [{ ...FIXED_ENGLISH, href: "/preise", path: "/preise", text: "See our prices" }],
      }),
    ]);
    expect(rulesOf(found)).toContainEqual(["cross-locale-content-link", HOME_EN]);
  });
});

describe("hreflang, canonical, sitemap, page language", () => {
  it("reports a one-sided alternate, a missing self-reference and a cross-language canonical", () => {
    const model = new BuildModel(state());
    const en = facts(PRICES_EN, "/en/pricing", "en", {
      // Lists only the German page, and points its canonical there.
      alternates: [{ hreflang: "de", href: `${BASE}/preise`, path: "/preise" }],
      canonical: { href: `${BASE}/preise`, path: "/preise" },
    });
    // The German page is noindex and does not name the English one.
    const deFacts = facts(PRICES_DE, "/preise", "de", {
      robots: "noindex",
      alternates: [
        { hreflang: "de", href: `${BASE}/preise`, path: "/preise" },
        { hreflang: "x-default", href: `${BASE}/preise`, path: "/preise" },
      ],
    });
    const found = pageFindings(model, [deFacts, en]);
    const rules = rulesOf(found);
    expect(rules).toContainEqual(["hreflang-self-missing", PRICES_EN]);
    expect(rules).toContainEqual(["canonical-cross-locale", PRICES_EN]);
    expect(rules).toContainEqual(["x-default-missing", PRICES_EN]);
    expect(rules).toContainEqual(["hreflang-not-reciprocal", PRICES_EN]);
    expect(rules).toContainEqual(["hreflang-missing-version", PRICES_DE]);
    // The English page names the noindex German one.
    expect(rules).toContainEqual(["hreflang-target-not-indexable", PRICES_EN]);
  });

  it("reports a wrong <html lang>, invalid codes and a sitemap that disagrees with the head", () => {
    const model = new BuildModel(state());
    const page = facts(PRICES_EN, "/en/pricing", "de", {
      sitemapAlternates: [{ hreflang: "en", href: `${BASE}/en/pricing`, path: "/en/pricing" }],
    });
    const rules = rulesOf(pageFindings(model, [page]));
    expect(rules).toContainEqual(["html-lang-mismatch", PRICES_EN]);
    expect(rules).toContainEqual(["sitemap-alternates-mismatch", PRICES_EN]);
    expect(hreflangProblem("en-UK")).toContain('"GB"');
    expect(hreflangProblem("de-AT")).toBeNull();
    expect(hreflangProblem("x-default")).toBeNull();
    expect(hreflangProblem("not a tag")).toContain("not a language tag");
  });
});

describe("content in the right language", () => {
  const germanTexts = [
    "Faire Preise für jedes Team, ohne versteckte Kosten und ohne Bindung.",
    "Starten Sie kostenlos und wechseln Sie jederzeit in einen größeren Plan.",
    "Alle Pläne enthalten Support per E-Mail und Chat, jeden Werktag.",
  ];
  const t = (text: string, moduleId: string | null = HERO, source = "text") => ({
    text,
    moduleId,
    listItem: null,
    pluginSlug: null,
    source,
  });

  it("a version that kept the source text is in the wrong language", () => {
    const model = new BuildModel(state());
    const found = pageFindings(model, [
      facts(PRICES_DE, "/preise", "de", { texts: germanTexts.map((x) => t(x)) }),
      facts(PRICES_EN, "/en/pricing", "en", {
        texts: germanTexts.map((x) => t(x)),
        title: "/preise title",
      }),
    ]);
    const rules = rulesOf(found);
    expect(rules).toContainEqual(["content-wrong-language", PRICES_EN]);
    // The source's title on the English version.
    expect(rules).toContainEqual(["seo-untranslated", PRICES_EN]);
  });

  it("left-over source text, untranslated chrome and alt texts are named", () => {
    const model = new BuildModel(state());
    const english = [
      "Fair prices for every team, with no hidden costs and no lock-in at all.",
      "Start for free and move to a bigger plan whenever you need to grow.",
      "Every plan includes support by email and chat on every working day.",
    ];
    const found = pageFindings(model, [
      facts(PRICES_DE, "/preise", "de", {
        texts: [
          ...germanTexts.map((x) => t(x)),
          t("Demo anfragen"),
          t("Impressum", FOOTER),
          t("Team im Büro", null, "alt"),
        ],
      }),
      facts(PRICES_EN, "/en/pricing", "en", {
        texts: [
          ...english.map((x) => t(x)),
          t("Demo anfragen"),
          t("Impressum", FOOTER),
          t("Team im Büro", null, "alt"),
        ],
      }),
    ]);
    const mixed = found.find((f) => f.rule === "content-mixed-language");
    expect(mixed?.message).toContain('"Demo anfragen"');
    expect(found.find((f) => f.rule === "chrome-untranslated")?.message).toContain(FOOTER);
    expect(rulesOf(found)).toContainEqual(["alt-untranslated", PRICES_EN]);
  });

  it("a term the glossary keeps as it is never counts as untranslated", () => {
    const model = new BuildModel(
      state({
        glossary: [
          {
            id: "g1",
            term: "Caelo Cloud",
            locale_code: "en",
            translation: "Caelo Cloud",
            context: null,
          },
        ],
      }),
    );
    const found = pageFindings(model, [
      facts(PRICES_DE, "/preise", "de", { texts: [t("Caelo Cloud")] }),
      facts(PRICES_EN, "/en/pricing", "en", { texts: [t("Caelo Cloud")] }),
    ]);
    expect(found.filter((f) => f.rule.startsWith("content-"))).toEqual([]);
  });

  it("flags a glossary term used against the glossary, and numbers in another language's format", () => {
    const model = new BuildModel(
      state({
        glossary: [
          { id: "g1", term: "Checkout", locale_code: "en", translation: "Basket", context: null },
        ],
      }),
    );
    const found = pageFindings(model, [
      facts(PRICES_EN, "/en/pricing", "en", { texts: [t("Go to Checkout"), t("from 1.234,56 €")] }),
    ]);
    const rules = rulesOf(found);
    expect(rules).toContainEqual(["glossary-violation", PRICES_EN]);
    expect(rules).toContainEqual(["locale-format", PRICES_EN]);
  });
});

describe("site rules and fact batches", () => {
  it("names stale translations, a language without its home page and broken groups", () => {
    const model = new BuildModel(
      state({
        variants: [
          variant(HOME_DE, "g-home", "de", "source"),
          variant(PRICES_DE, "g-prices", "de", "source"),
          variant(PRICES_EN, "g-prices", "en", "needs_update"),
          variant(TEAM_DE, "g-team", "de", "up_to_date"),
        ],
        stagedPages: [
          { pageId: HOME_DE, path: "/" },
          { pageId: PRICES_DE, path: "/preise" },
          { pageId: PRICES_EN, path: "/en/pricing" },
          { pageId: TEAM_DE, path: "/team" },
        ],
        staleChrome: [{ label: "Footer", localeCode: "en" }],
      }),
    );
    const found = siteFindings(model);
    const rules = rulesOf(found);
    expect(rules).toContainEqual(["translation-stale", PRICES_EN]);
    expect(rules).toContainEqual(["chrome-translation-stale", undefined]);
    expect(rules).toContainEqual(["locale-home-missing", undefined]);
    expect(rules).toContainEqual(["variant-group-broken", TEAM_DE]);
    expect(found.find((f) => f.rule === "coverage")?.severity).toBe("info");
    // A missing translation is a clean 404 by design — never an error.
    expect(
      found
        .filter((f) => f.rule === "coverage" || f.rule === "locale-empty")
        .every((f) => f.severity !== "error"),
    ).toBe(true);
  });

  it("keeps each language group in one batch and fills batches up", () => {
    const many = Array.from({ length: FACT_BATCH_PAGES + 20 }, (_, i) => ({
      pageId: id(100 + i),
      path: `/p${i}`,
    }));
    const model = new BuildModel(state({ stagedPages: [...state().stagedPages, ...many] }));
    const batches = factBatchesOf(model);
    expect(batches[0]?.slice(0, 4)).toEqual([HOME_DE, HOME_EN, PRICES_DE, PRICES_EN]);
    expect(batches.every((b) => b.length <= FACT_BATCH_PAGES)).toBe(true);
    expect(batches.flat()).toHaveLength(model.state.stagedPages.length);
  });
});
