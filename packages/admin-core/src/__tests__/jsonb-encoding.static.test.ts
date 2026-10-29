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
 * So this static scan fails the build if any `}::jsonb` appears in source —
 * and, for `tx.unsafe(text, params)` queries, any `$1::jsonb` placeholder
 * (a string param there double-encodes the same way). It scans the `src/`
 * of every package AND app (server routes write jsonb too) and runs as a
 * plain unit test (no DB) so it gates every PR. Writes that double-encode
 * through the column type (`VALUES (${JSON.stringify(x)})`, no cast) have
 * no fixed spelling; the test preload's after-file scan
 * (`scripts/jsonb-double-encoding-scan.ts`) catches those from the data.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Repo root, four levels up from this file (packages/admin-core/src/__tests__). */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");
const APPS_DIR = join(REPO_ROOT, "apps");

/**
 * The dangerous forms: a template-expression close-brace immediately cast
 * to jsonb, or a positional placeholder cast to jsonb (`tx.unsafe`).
 */
const DANGEROUS = /\}::jsonb|\$\d+::jsonb/;

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
    if (!full.endsWith(".ts") && !full.endsWith(".svelte")) continue;
    if (full.endsWith(".test.ts")) continue;
    if (full.includes(`${"/"}__tests__${"/"}`)) continue;
    out.push(full);
  }
}

describe("jsonb write encoding (issue #68 regression guard)", () => {
  it("flags the double-encoding forms and passes the safe ones", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    expect(DANGEROUS.test("SET v = ${JSON.stringify(x)}::jsonb")).toBe(true);
    expect(DANGEROUS.test("tx.unsafe('UPDATE t SET v = $2::jsonb', [id, json])")).toBe(true);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    expect(DANGEROUS.test("SET v = (${json}::text)::jsonb")).toBe(false);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    expect(DANGEROUS.test("SET v = ${jsonbParam(x)}")).toBe(false);
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal double-encoding form we are asserting against
  it("no source file writes jsonb via the double-encoding `${expr}::jsonb` form", () => {
    // Only `src/` dirs of each package and app hold shippable source.
    const roots: string[] = [];
    for (const parent of [PACKAGES_DIR, APPS_DIR]) {
      for (const pkg of readdirSync(parent)) {
        const src = join(parent, pkg, "src");
        try {
          if (statSync(src).isDirectory()) roots.push(src);
        } catch {
          // package without a src/ dir — skip.
        }
      }
    }

    const files: string[] = [];
    for (const root of roots) collectTsFiles(root, files);

    const offenders: string[] = [];
    for (const file of files) {
      if (ALLOWLIST.has(file)) continue;
      const text = readFileSync(file, "utf8");
      if (!DANGEROUS.test(text)) continue;
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (DANGEROUS.test(line)) {
          offenders.push(`${file.slice(REPO_ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    // Sanity: the scan actually walked a meaningful number of files (apps
    // included), otherwise a broken path would make this guard silently pass.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.startsWith(APPS_DIR))).toBe(true);

    expect(
      offenders,
      `Found jsonb writes using the double-encoding \`\${expr}::jsonb\` form. ` +
        `Use jsonbParam(value) from sql-helpers, or the inline \`(\${s}::text)::jsonb\` ` +
        `cast. See issue #68.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
