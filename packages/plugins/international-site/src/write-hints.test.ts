// SPDX-License-Identifier: MPL-2.0

/**
 * Write hints: a module or content write that hardcodes a link into
 * another language is told so in the same tool result, before the Stage
 * audit's `hardcoded-language-link` has to find it.
 */

import { describe, expect, it } from "bun:test";
import type { LocaleRow, PageVariantRow } from "./index.js";
import { type WriteHintState, writeHints } from "./write-hints.js";

const de: LocaleRow = {
  id: "l-de",
  code: "de",
  display_name: "Deutsch",
  url_strategy: "subdirectory",
  url_host: null,
  is_default: true,
};
const en: LocaleRow = { ...de, id: "l-en", code: "en", display_name: "English", is_default: false };
const HOME_DE = "00000000-0000-4000-8000-000000000001";
const HOME_EN = "00000000-0000-4000-8000-000000000002";

const row = (page: string, locale: string): PageVariantRow => ({
  id: `v-${page}`,
  group_id: "g-home",
  page_id: page,
  locale_code: locale,
  translation_status: locale === "de" ? "source" : "up_to_date",
  source_event_cursor: null,
});

const STATE: WriteHintState = {
  locales: new Map([
    ["de", de],
    ["en", en],
  ]),
  prefixDefaultLocale: false,
  variants: [row(HOME_DE, "de"), row(HOME_EN, "en")],
  siteHomePageId: HOME_DE,
};

describe("write hints", () => {
  it("names a fixed link into another language, in markup and in field defaults", () => {
    const fromHtml = writeHints(STATE, [
      { kind: "module", moduleId: "m1", html: '<a href="/en/">English</a>', fields: [] },
    ]);
    expect(fromHtml).toHaveLength(1);
    expect(fromHtml[0]).toContain("/en/");
    expect(fromHtml[0]).toContain("{{#language_links}}");
    const fromDefault = writeHints(STATE, [
      {
        kind: "module",
        moduleId: "m1",
        html: '<a href="{{lang_href}}">{{lang_label}}</a>',
        fields: [{ name: "lang_href", kind: "link", default: { href: "/en/pricing" } }],
      },
    ]);
    expect(fromDefault[0]).toContain("/en/pricing");
  });

  it("names a page link to another language's home and a literal hreflang", () => {
    const hints = writeHints(STATE, [
      {
        kind: "values",
        moduleId: null,
        values: { lang: { href: `caelo:page/${HOME_EN}` } },
      },
      { kind: "module", moduleId: "m2", html: '<a hreflang="en" href="{{x}}">EN</a>', fields: [] },
    ]);
    expect(hints[0]).toContain("English home page is a page link");
    expect(hints[0]).toContain('hreflang="en"');
  });

  it("stays quiet for language_links, the default home (a logo) and one-language sites", () => {
    expect(
      writeHints(STATE, [
        {
          kind: "module",
          moduleId: "m3",
          html: '<nav>{{#language_links}}<a href="{{href}}" hreflang="{{locale}}">{{label}}</a>{{/language_links}}</nav>',
          fields: [],
        },
        {
          kind: "values",
          moduleId: null,
          values: { logo_link: { href: `caelo:page/${HOME_DE}` } },
        },
        { kind: "values", moduleId: null, values: { cta: { href: "/preise" } } },
      ]),
    ).toEqual([]);
    expect(
      writeHints({ ...STATE, locales: new Map([["de", de]]) }, [
        { kind: "module", moduleId: "m1", html: '<a href="/en/">English</a>', fields: [] },
      ]),
    ).toEqual([]);
  });
});
