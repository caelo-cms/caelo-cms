// SPDX-License-Identifier: MPL-2.0
/**
 * #551 contract: no runtime code substitutes a localhost site URL (and,
 * since migration 0232, no `en` site language). The old
 * `?? "http://localhost:8082"` fallbacks put localhost canonicals,
 * og:url and sitemap entries into production builds; an unset base URL
 * must surface as an error (generator) or a missing-content flag
 * (preview) instead. Tests, e2e fixtures, Playwright configs and
 * migrations are exempt.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ROOTS = ["packages", "apps"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".svelte-kit",
  "__tests__",
  "e2e",
  "e2e-livedit",
  "migrations",
]);

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* sourceFiles(p);
    else if (/\.(ts|svelte)$/.test(name) && !/(\.test|^playwright.*\.config)\.ts$/.test(name))
      yield p;
  }
}

describe("#551 no localhost site-URL fallback in runtime code", () => {
  it("no runtime source contains the old localhost:8082 default", () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const f of sourceFiles(join(REPO_ROOT, root))) {
        if (readFileSync(f, "utf8").includes("localhost:8082")) hits.push(relative(REPO_ROOT, f));
      }
    }
    expect(hits).toEqual([]);
  });
});

// Migration 0232: the site language has no `en` default either. An unset
// language is surfaced (generator error, preview `site-language-unset`),
// never filled in at read time with `?? "en"` / `|| "en"`.
const LANGUAGE_FALLBACK_RE = /[lL]anguage\b[^\n;]*(\?\?|\|\|)\s*["'`]en["'`]/;

describe("0232 no `en` site-language fallback in runtime code", () => {
  it("no runtime source substitutes `en` for a missing language", () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const f of sourceFiles(join(REPO_ROOT, root))) {
        if (LANGUAGE_FALLBACK_RE.test(readFileSync(f, "utf8"))) hits.push(relative(REPO_ROOT, f));
      }
    }
    expect(hits).toEqual([]);
  });

  it("the pattern catches the fallback shapes it exists for", () => {
    expect(LANGUAGE_FALLBACK_RE.test('lang: r.site_language ?? "en"')).toBe(true);
    expect(LANGUAGE_FALLBACK_RE.test("const siteLanguage = row.lang || 'en';")).toBe(true);
    expect(LANGUAGE_FALLBACK_RE.test("siteLanguage: r.site_language,")).toBe(false);
  });
});
