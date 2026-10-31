// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1267 (rule 7 of docs/dev/state-and-changes.md) — no SQL list binds
 * one parameter per element.
 *
 * `IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})` sends one
 * bind parameter per id. Postgres refuses a statement past 65,535
 * parameters, so the same code that works on a small site fails on a large
 * Stage (20,000 pending snapshots) or a 50,000-page site — and it plans a
 * new statement for every list length. Bind ONE array parameter instead:
 * `= ANY(${uuidArray(ids)})` / `<> ALL(${textArray(slugs)})` from
 * @caelo-cms/query-api (a JSON array expanded server-side).
 *
 * The scan fails on
 * - `sql.join(` building an `IN (…)`, `NOT IN (…)`, `ANY(…)`, `ALL(…)` or
 *   `ARRAY[…]` list, and
 * - a `sql.join(xs.map((x) => sql`${x}`), sql`, `)` comma list of single
 *   bound values anywhere (the same list built in a variable or helper and
 *   spliced into an `IN` later).
 * Rows of a multi-value VALUES list (`(${a}, ${b})` per element) are not
 * matched: they are a different shape, bounded by their batch size.
 *
 * A list provably bounded by a schema may stay, with the reason in a
 * `// caelo:bounded-list <reason>` comment on the line before. Keep it rare.
 */

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures and the fix text are SQL template source, matched as text
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ROOTS = ["packages", "apps"].map((d) => resolve(REPO_ROOT, d));
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "__tests__", "e2e", "e2e-livedit"]);

const CONTEXT_LIST = /(\bIN|\bANY|\bALL)\s*\(\s*\$\{sql\.join\(|ARRAY\[\$\{sql\.join\(/g;
const VALUE_LIST =
  /sql\.join\(\s*[^`;]*?\.map\(\s*\(?\w+\)?\s*=>\s*sql`\$\{[^}`]+\}(::\w+(\[\])?)?`\s*,?\s*\)\s*,\s*sql`, `/g;
const BOUNDED = /caelo:bounded-list\s+\S/;

/** One finding: a list built from one bind parameter per element. */
export interface BindListFinding {
  readonly line: number;
  readonly snippet: string;
}

/** Find per-element bind lists in one source text (exported for the self-test). */
export function findUnboundedBindLists(source: string): BindListFinding[] {
  const lines = source.split("\n");
  const at = new Map<number, BindListFinding>();
  for (const re of [CONTEXT_LIST, VALUE_LIST]) {
    for (const m of source.matchAll(re)) {
      const offset = (m.index ?? 0) + m[0].indexOf("sql.join(");
      const line = source.slice(0, offset).split("\n").length;
      const here = lines[line - 1] ?? "";
      const before = lines[line - 2] ?? "";
      if (BOUNDED.test(before) || BOUNDED.test(here)) continue;
      at.set(line, { line, snippet: here.trim() });
    }
  }
  return [...at.values()].sort((a, b) => a.line - b.line);
}

function isProductionSource(path: string): boolean {
  if (!path.endsWith(".ts") || path.endsWith(".d.ts")) return false;
  if (/\.(test|bench|browser)\.ts$/.test(path)) return false;
  return /\/src\//.test(path);
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (isProductionSource(path)) out.push(path);
  }
  return out;
}

describe("findUnboundedBindLists (self-test)", () => {
  it("finds an IN list, a NOT IN list, an ARRAY list and a list built in a variable", () => {
    const src = [
      "const a = sql`WHERE id IN (${sql.join(",
      "  ids.map((id) => sql`${id}::uuid`),",
      "  sql`, `,",
      ")})`;",
      "const b = sql`WHERE s NOT IN (${sql.join(xs.map((x) => sql`${x}`), sql`, `)})`;",
      "const c = sql`ARRAY[${sql.join(xs.map((x) => sql`${x}`), sql`, `)}]::text[]`;",
      "const d = sql.join(",
      "  rows.map((r) => sql`${r.id}::uuid`),",
      "  sql`, `,",
      ");",
    ].join("\n");
    expect(findUnboundedBindLists(src).map((f) => f.line)).toEqual([1, 5, 6, 7]);
  });

  it("passes one array parameter, a VALUES list, an AND chain and a bounded list with its reason", () => {
    const src = [
      "const a = sql`WHERE id = ANY(${uuidArray(ids)})`;",
      "const v = sql.join(rows.map((r) => sql`(${r.a}, ${r.b})`), sql`, `);",
      "const w = sql`WHERE ${sql.join(wheres, sql` AND `)}`;",
      "// caelo:bounded-list the schema caps it at 1000 values",
      "const b = sql`x IN (${sql.join(vs.map((v) => sql`${v}`), sql`, `)})`;",
    ].join("\n");
    expect(findUnboundedBindLists(src)).toEqual([]);
  });

  it("does not accept the marker without a reason", () => {
    const src = [
      "// caelo:bounded-list",
      "const b = sql`x IN (${sql.join(vs.map((v) => sql`${v}`), sql`, `)})`;",
    ].join("\n");
    expect(findUnboundedBindLists(src).map((f) => f.line)).toEqual([2]);
  });
});

describe("#1267 — no SQL list binds one parameter per element", () => {
  it("every list of values is ONE array parameter (or bounded, with its reason)", () => {
    const findings: string[] = [];
    for (const root of ROOTS) {
      for (const path of sources(root)) {
        for (const f of findUnboundedBindLists(readFileSync(path, "utf8"))) {
          findings.push(`${relative(REPO_ROOT, path)}:${f.line}  ${f.snippet}`);
        }
      }
    }
    expect(
      findings,
      `${findings.length} list(s) bind one parameter per element; Postgres refuses more than 65,535. ` +
        "Bind ONE array parameter: `= ANY(${uuidArray(ids)})` / `<> ALL(${textArray(values)})` from " +
        "@caelo-cms/query-api, or — only for a list a schema bounds — put `// caelo:bounded-list <reason>` " +
        "on the line before.",
    ).toEqual([]);
  });
});
