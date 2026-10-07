// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  applyDocumentLanguage,
  languageTagSchema,
  resolveDocumentLanguage,
} from "./document-language.js";

describe("applyDocumentLanguage", () => {
  // Regression: every composed page started with a bare `<html>`, so
  // Lighthouse flagged html-has-lang on the whole site.
  it("adds lang to a bare <html>", () => {
    expect(applyDocumentLanguage("<!doctype html><html><head></head></html>", "en")).toBe(
      '<!doctype html><html lang="en"><head></head></html>',
    );
  });

  it("replaces a layout-authored lang (quoted, single-quoted, unquoted, bare)", () => {
    for (const tag of [
      '<html lang="xx">',
      "<html lang='xx'>",
      "<html lang=xx>",
      "<html lang>",
      '<html LANG="xx">',
    ]) {
      expect(applyDocumentLanguage(`${tag}<head></head>`, "de")).toBe(
        '<html lang="de"><head></head>',
      );
    }
  });

  it("keeps other attributes, including xml:lang and `>` inside quoted values", () => {
    expect(
      applyDocumentLanguage(
        '<html class="dark" data-x="a>b" xml:lang="xx" lang="xx" dir="ltr"><head></head>',
        "pt-BR",
      ),
    ).toBe('<html lang="pt-BR" class="dark" data-x="a>b" xml:lang="xx" dir="ltr"><head></head>');
  });

  it("only touches the first <html> start tag, never look-alikes", () => {
    const html = '<html-widget lang="xx"></html-widget><html><body><html></body></html>';
    expect(applyDocumentLanguage(html, "en")).toBe(
      '<html-widget lang="xx"></html-widget><html lang="en"><body><html></body></html>',
    );
  });

  it("inserts an <html> start tag after the doctype when the layout omits it", () => {
    expect(applyDocumentLanguage("<!DOCTYPE html>\n<head></head><body></body>", "en")).toBe(
      '<!DOCTYPE html><html lang="en">\n<head></head><body></body>',
    );
    expect(applyDocumentLanguage("<head></head><body></body>", "en")).toBe(
      '<html lang="en"><head></head><body></body>',
    );
  });

  it("keeps data-lang and self-closing slashes, drops every lang", () => {
    expect(applyDocumentLanguage('<html data-lang="x" lang=a\tlang="b" />', "en")).toBe(
      '<html lang="en" data-lang="x" />',
    );
  });

  // Regression (CodeQL js/polynomial-redos): the attribute strip was a
  // global `\s+lang…` regex that backtracked quadratically over long
  // whitespace runs in layout HTML.
  it("stays linear on long whitespace runs", () => {
    const ws = "\t".repeat(200_000);
    const started = performance.now();
    expect(applyDocumentLanguage(`<html${ws}x${ws}>`, "en")).toBe(`<html lang="en"${ws}x${ws}>`);
    expect(applyDocumentLanguage(`<html${ws}`, "en")).toBe(`<html lang="en"><html${ws}`);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  // Migration 0232: an unconfigured site language renders no `lang`
  // rather than a substituted one.
  it("with no language, strips a layout-authored lang and adds none", () => {
    expect(applyDocumentLanguage('<html lang="en" class="x"><head></head>', null)).toBe(
      '<html class="x"><head></head>',
    );
    expect(applyDocumentLanguage("<!doctype html><head></head>", null)).toBe(
      "<!doctype html><head></head>",
    );
  });

  it("escapes the value", () => {
    expect(applyDocumentLanguage("<html>", 'a"b')).toBe('<html lang="a&quot;b">');
  });
});

describe("resolveDocumentLanguage", () => {
  it("prefers the plugin-contributed per-page language", () => {
    expect(resolveDocumentLanguage({ contributed: "de", siteLanguage: "en" })).toBe("de");
  });

  it("uses the stored site language when no plugin assigns one", () => {
    expect(resolveDocumentLanguage({ contributed: undefined, siteLanguage: "fr" })).toBe("fr");
  });

  it("returns null when neither a plugin nor the site sets a language — never 'en'", () => {
    expect(resolveDocumentLanguage({ contributed: undefined, siteLanguage: null })).toBeNull();
    expect(resolveDocumentLanguage({ contributed: "de", siteLanguage: null })).toBe("de");
  });
});

describe("languageTagSchema", () => {
  it("accepts BCP 47 shaped tags", () => {
    for (const tag of ["en", "de", "pt-BR", "zh-Hant-TW", "es-419", "gsw"]) {
      expect(languageTagSchema.safeParse(tag).success).toBe(true);
    }
  });

  it("rejects malformed tags", () => {
    for (const tag of ["", "e", "en_US", "en-", "-en", 'en" onload="x', "x".repeat(36)]) {
      expect(languageTagSchema.safeParse(tag).success).toBe(false);
    }
  });
});
