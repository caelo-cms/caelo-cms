// SPDX-License-Identifier: MPL-2.0

/**
 * Regression guard for issue #68 — bun:SQL jsonb double-encoding.
 *
 * bun's SQL adapter binds a JS string param under a `::jsonb` cast as a jsonb
 * *string scalar*, so `sql`${JSON.stringify(obj)}::jsonb`` stores
 * `"{\"a\":1}"` (jsonb_typeof = `string`), not the structured object. The safe
 * idiom routes the text through `::text` first — `(${s}::text)::jsonb` — which
 * makes Postgres parse the JSON. The shared `jsonbParam()` helper emits that
 * form; the ops layer must go through it (or the inline `(...::text)::jsonb`
 * cast) for every jsonb write.
 *
 * The two forms are trivially distinguishable in source:
 *   - dangerous: `${expr}::jsonb`   → the char before `::jsonb` is `}`
 *   - safe:      `(${expr}::text)::jsonb` → the char before `::jsonb` is `)`
 *
 * So this static scan fails the build if any `}::jsonb` appears in source. It
 * runs as a plain unit test (no DB) so it gates every PR.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Repo root, four levels up from this file (packages/admin-core/src/__tests__). */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");

/** The dangerous literal: a template-expression close-brace immediately cast to jsonb. */
const DANGEROUS = "}::jsonb";

/**
 * Files that legitimately contain the dangerous literal as documentation, not
 * as an executed SQL fragment. `sql-helpers.ts` defines `jsonbParam` and quotes
 * the anti-pattern in its TSDoc; this test file quotes it too.
 */
const ALLOWLIST = new Set([
  join(PACKAGES_DIR, "admin-core", "src", "sql-helpers.ts"),
  join(PACKAGES_DIR, "admin-core", "src", "__tests__", "jsonb-encoding.static.test.ts"),
]);

function collectTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === ".svelte-kit") continue;
      collectTsFiles(full, out);
      continue;
    }
    // Only scan the source tree; the guarded write sites are production code.
    // Test files may quote the anti-pattern in fixtures/comments.
    if (!full.endsWith(".ts")) continue;
    if (full.endsWith(".test.ts")) continue;
    if (full.includes(`${"/"}__tests__${"/"}`)) continue;
    out.push(full);
  }
}

describe("jsonb write encoding (issue #68 regression guard)", () => {
  it("no source file writes jsonb via the double-encoding `${expr}::jsonb` form", () => {
    // Only `src/` dirs of each package hold shippable source.
    const roots: string[] = [];
    for (const pkg of readdirSync(PACKAGES_DIR)) {
      const src = join(PACKAGES_DIR, pkg, "src");
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch {
        // package without a src/ dir — skip.
      }
    }

    const files: string[] = [];
    for (const root of roots) collectTsFiles(root, files);

    const offenders: string[] = [];
    for (const file of files) {
      if (ALLOWLIST.has(file)) continue;
      const text = readFileSync(file, "utf8");
      if (!text.includes(DANGEROUS)) continue;
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (line.includes(DANGEROUS)) {
          offenders.push(`${file.slice(REPO_ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    // Sanity: the scan actually walked a meaningful number of files, otherwise a
    // broken path would make this guard silently pass.
    expect(files.length).toBeGreaterThan(50);

    expect(
      offenders,
      `Found jsonb writes using the double-encoding \`\${expr}::jsonb\` form. ` +
        `Use jsonbParam(value) from sql-helpers, or the inline \`(\${s}::text)::jsonb\` ` +
        `cast. See issue #68.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
