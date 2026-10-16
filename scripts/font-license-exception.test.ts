// SPDX-License-Identifier: MPL-2.0

/**
 * Guards the "OFL-1.1 for font packages only" exception (CLAUDE.md §3,
 * issue #778). The admin self-hosts its brand fonts, which are OFL-1.1 —
 * a licence we accept for fonts and nothing else. The exception lives in
 * two gates that must agree:
 *
 * - `package.json` → `license:check:deps` runs the global MPL-compatible
 *   `--onlyAllow` set (no OFL) and excludes the font packages;
 *   `license:check:fonts` checks exactly those packages against `OFL-1.1`.
 * - `.github/workflows/dependency-review.yml` → the fonts are exempted by
 *   purl via `allow-dependencies-licenses`; `allow-licenses` stays OFL-free.
 *
 * Widening either gate to a non-font package — or adding OFL to a global
 * allow-list — fails here. Pure-string assertions, no YAML parser, matching
 * `scripts/codeql-workflow.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const adminPkg = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "apps/admin/package.json"), "utf8"),
) as { dependencies: Record<string, string> };
const depReview = readFileSync(
  resolve(REPO_ROOT, ".github/workflows/dependency-review.yml"),
  "utf8",
);

/** Font packages are recognisable by their Fontsource scope; nothing else may use OFL. */
const FONT_PACKAGE = /^@fontsource(-variable)?\/[a-z0-9-]+$/;

function script(name: string): string {
  const s = pkg.scripts[name];
  if (!s) throw new Error(`package.json has no ${name} script`);
  return s;
}

/** Reads a single-quoted, semicolon-separated CLI list such as `--onlyAllow 'a;b'`. */
function cliList(source: string, flag: string): string[] {
  const m = source.match(new RegExp(`--${flag}\\s+'([^']+)'`));
  if (!m) throw new Error(`missing --${flag} '...' in: ${source}`);
  return m[1]!
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `allow-dependencies-licenses` purls, reduced to npm package names. */
function exemptedPackages(): string[] {
  const m = depReview.match(/allow-dependencies-licenses:\s*(.+)/);
  if (!m) throw new Error("dependency-review.yml has no allow-dependencies-licenses line");
  return m[1]!
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((purl) => {
      const n = purl.match(/^pkg:npm\/(.+)$/);
      if (!n) throw new Error(`not an npm purl: ${purl}`);
      return decodeURIComponent(n[1]!);
    });
}

const fontPackages = cliList(script("license:check:fonts"), "includePackages");

describe("OFL-1.1 font-only licence exception", () => {
  it("license:check runs both the global and the font gate", () => {
    expect(script("license:check")).toBe(
      "bun run license:check:deps && bun run license:check:fonts",
    );
  });

  it("the font gate allows OFL-1.1 and nothing else", () => {
    expect(cliList(script("license:check:fonts"), "onlyAllow")).toEqual(["OFL-1.1"]);
  });

  it("only font packages are allowed OFL-1.1", () => {
    expect(fontPackages.length).toBeGreaterThan(0);
    for (const name of fontPackages) expect(name).toMatch(FONT_PACKAGE);
  });

  it("every exempted font is a real admin dependency (no stale entries)", () => {
    for (const name of fontPackages) expect(Object.keys(adminPkg.dependencies)).toContain(name);
  });

  it("the global gate excludes exactly the font packages (plus the root)", () => {
    const excluded = cliList(script("license:check:deps"), "excludePackages");
    expect(excluded.filter((n) => n !== "caelo-cms").sort()).toEqual([...fontPackages].sort());
  });

  it("no global allow-list carries OFL", () => {
    expect(cliList(script("license:check:deps"), "onlyAllow").join(";")).not.toMatch(/OFL/i);
    const allow = depReview.match(/allow-licenses:\s*(.+)/)?.[1] ?? "";
    expect(allow).not.toMatch(/OFL/i);
  });

  it("dependency-review exempts exactly the same font packages", () => {
    const exempted = exemptedPackages();
    for (const name of exempted) expect(name).toMatch(FONT_PACKAGE);
    expect([...exempted].sort()).toEqual([...fontPackages].sort());
  });
});
