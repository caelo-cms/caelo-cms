// SPDX-License-Identifier: MPL-2.0

/**
 * Shared parsing for the licence-gate tests (`license-check.test.ts`,
 * `font-license-exception.test.ts`). Pure-string, no YAML parser.
 */

/**
 * Reads `allow-dependencies-licenses` from dependency-review.yml — a one-line
 * value or a `>-` folded block of comma-separated purls — and returns the npm
 * package names.
 */
export function dependencyReviewExemptions(workflow: string): string[] {
  const m = workflow.match(
    /allow-dependencies-licenses:[ \t]*(>-\n((?:[ \t]+pkg:[^\n]*\n?)+)|[^\n]+)/,
  );
  if (!m) throw new Error("dependency-review.yml has no allow-dependencies-licenses entry");
  const value = m[2] ?? m[1]!;
  return value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((purl) => {
      const n = purl.match(/^pkg:npm\/(.+)$/);
      if (!n) throw new Error(`not an npm purl: ${purl}`);
      return decodeURIComponent(n[1]!);
    });
}
