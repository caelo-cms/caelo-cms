// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1277 — no AI-facing text tells the model to resend or re-call
 * a whole call. A failed call names what to change (an absolute path in
 * `errors[]`); "resend all N" / "re-call with …" makes the model re-emit
 * every module's HTML to fix one value, which costs the most expensive
 * tokens of the turn (output) for nothing (#1275 patches instead).
 *
 * Scans the tool texts and every op / shared / query-api message, code
 * only (comments may discuss the old wording).
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../../../..");
const DIRS = [
  "packages/admin-core/src/ai",
  "packages/admin-core/src/ops",
  "packages/admin-core/src/lists",
  "packages/shared/src",
  "packages/query-api/src",
];

const FORBIDDEN: readonly RegExp[] = [
  /\bre-?send (all|the whole|it|with|every|plain|the js|the call)\b/i,
  /\bre-call\b/i,
  /\bresend all \$\{/i,
  /whole batch was rolled back/i,
  /\bresend the whole batch\b/i,
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "node_modules" || name === "dist") continue;
      out.push(...sourceFiles(p));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** The file's lines that are code, not comments. */
function codeLines(text: string): { line: number; text: string }[] {
  return text
    .split("\n")
    .map((t, i) => ({ line: i + 1, text: t }))
    .filter(({ text: t }) => {
      const s = t.trim();
      return !(s.startsWith("//") || s.startsWith("*") || s.startsWith("/*"));
    });
}

describe("no resend / re-call wording in AI-facing texts (#1277)", () => {
  it("finds none", () => {
    const hits: string[] = [];
    for (const dir of DIRS) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        for (const { line, text } of codeLines(readFileSync(file, "utf8"))) {
          if (FORBIDDEN.some((re) => re.test(text))) {
            hits.push(`${file.slice(ROOT.length + 1)}:${line}: ${text.trim().slice(0, 140)}`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("the patterns catch the wording they forbid", () => {
    for (const sample of [
      "fix this item and resend all 3.",
      "Re-call `build_page` with only the listed properties",
      "Fix the definition and resend the whole batch.",
      "The whole batch was rolled back",
    ]) {
      expect(FORBIDDEN.some((re) => re.test(sample))).toBe(true);
    }
  });
});
