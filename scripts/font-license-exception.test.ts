// SPDX-License-Identifier: MPL-2.0

/**
 * Guards the "OFL-1.1 for font packages only" exception (CLAUDE.md §3,
 * issue #778). The admin self-hosts its brand fonts, which are OFL-1.1 —
 * a licence we accept for fonts and nothing else. The exception lives in
 * two gates that must agree:
 *
 * - `scripts/license-check.ts` → `LICENSE_EXCEPTIONS` carries one OFL-1.1
 *   entry per font package; `ALLOWED_LICENSES` (the global set) has no OFL.
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
import { dependencyReviewExemptions } from "./license-check.test-helpers.ts";
import { ALLOWED_LICENSES, LICENSE_EXCEPTIONS } from "./license-check.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const adminPkg = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "apps/admin/package.json"), "utf8"),
) as { dependencies: Record<string, string> };
const depReview = readFileSync(
  resolve(REPO_ROOT, ".github/workflows/dependency-review.yml"),
  "utf8",
);

/** Font packages are recognisable by their Fontsource scope; nothing else may use OFL. */
const FONT_PACKAGE = /^@fontsource(-variable)?\/[a-z0-9-]+$/;

const oflExceptions = LICENSE_EXCEPTIONS.filter((e) => /OFL/i.test(e.license));
const fontPackages = oflExceptions.map((e) => {
  if (typeof e.name !== "string") throw new Error(`OFL exception must name one package: ${e.name}`);
  return e.name;
});

describe("OFL-1.1 font-only licence exception", () => {
  it("OFL exceptions are exactly OFL-1.1, one font package each", () => {
    expect(fontPackages.length).toBeGreaterThan(0);
    for (const e of oflExceptions) expect(e.license).toBe("OFL-1.1");
    for (const name of fontPackages) expect(name).toMatch(FONT_PACKAGE);
  });

  it("every exempted font is a real admin dependency (no stale entries)", () => {
    for (const name of fontPackages) expect(Object.keys(adminPkg.dependencies)).toContain(name);
  });

  it("no global allow-list carries OFL", () => {
    expect(ALLOWED_LICENSES.join(";")).not.toMatch(/OFL/i);
    const allow = depReview.match(/allow-licenses:\s*(.+)/)?.[1] ?? "";
    expect(allow).not.toMatch(/OFL/i);
  });

  it("dependency-review exempts exactly the same font packages", () => {
    const exemptedFonts = dependencyReviewExemptions(depReview).filter((n) =>
      n.startsWith("@fontsource"),
    );
    for (const name of exemptedFonts) expect(name).toMatch(FONT_PACKAGE);
    expect([...exemptedFonts].sort()).toEqual([...fontPackages].sort());
  });
});
