#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * Migration lint — finds contract (destructive) statements in the SQL
 * migrations added since the previous release tag (epic #696).
 *
 * Caelo's release rule is expand-only: the N-1 image must keep running on
 * the N schema, because an upgrade migrates first and rolls images second
 * (and a rollback puts N-1 back on the migrated schema). A statement that
 * removes or renames something N-1 reads breaks that, so a release that
 * carries one is a *contract* release: `migrations.contract = true` in the
 * signed manifest, which keeps the upgrader from installing it unattended.
 *
 * Flagged: DROP TABLE / COLUMN / SCHEMA / TYPE / VIEW / MATERIALIZED VIEW /
 * DOMAIN / SEQUENCE / FUNCTION, ALTER TYPE, any RENAME, and ALTER COLUMN
 * … TYPE. Not flagged: DROP POLICY / CONSTRAINT / INDEX / TRIGGER — the
 * migrations drop and recreate those routinely, and none of them removes
 * data or a name the previous image reads.
 *
 *   bun scripts/migration-lint.ts [--since <tag>]   # default: previous stable tag
 *
 * Exit 0 always prints the findings; `--fail-on-contract` exits 1 when any
 * are found (for ad-hoc use in CI).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Where the SQL migrations live, repo-relative. */
export const MIGRATIONS_DIR = "packages/migrations/migrations";

/** One destructive statement in one migration file. */
export interface ContractFinding {
  readonly file: string;
  readonly rule: string;
  readonly statement: string;
}

const RULES: readonly { id: string; pattern: RegExp }[] = [
  {
    id: "drop-object",
    pattern:
      /\bDROP\s+(TABLE|SCHEMA|TYPE|VIEW|MATERIALIZED\s+VIEW|DOMAIN|SEQUENCE|FUNCTION|PROCEDURE)\b/i,
  },
  // `ALTER TABLE t DROP [COLUMN] c` — COLUMN is optional in Postgres, so
  // any ALTER TABLE … DROP that is not one of the non-column forms.
  {
    id: "drop-column",
    pattern:
      /\bALTER\s+TABLE\b[\s\S]*\bDROP\s+(?!CONSTRAINT\b|DEFAULT\b|NOT\s+NULL\b|IDENTITY\b|EXPRESSION\b|POLICY\b|TRIGGER\b|INDEX\b)/i,
  },
  { id: "alter-type", pattern: /\bALTER\s+TYPE\b/i },
  { id: "rename", pattern: /\bRENAME\b/i },
  // `TYPE` must be followed by a type, so a column NAMED `type`
  // (`ALTER COLUMN type SET NOT NULL`) is not mistaken for a type change.
  {
    id: "alter-column-type",
    pattern: /\bALTER\s+(COLUMN\s+)?\S+\s+(SET\s+DATA\s+)?TYPE\s+(?!SET\b|DROP\b)["\w]/i,
  },
];

/** Index of the quote closing the literal opened at `open` (`''`/`""` escapes). */
function closingQuote(sql: string, open: number, quote: "'" | '"'): number {
  let j = open + 1;
  while (j < sql.length) {
    if (sql[j] === quote) {
      if (sql[j + 1] !== quote) return j;
      j += 2;
    } else j++;
  }
  return sql.length - 1;
}

/**
 * One left-to-right scan that drops comments and blanks string literals
 * OUTSIDE dollar-quoted bodies, so a word inside a comment or a seeded
 * text value is not flagged. Comments and strings are tokenized together:
 * a `--` inside a string is not a comment, a quote inside a comment opens
 * no string. Inside a `$$ … $$` body (DO blocks, functions) strings are
 * KEPT: there they are usually SQL run by `EXECUTE 'DROP TABLE …'` —
 * conservative by design.
 */
function stripCommentsAndStrings(input: string): string {
  const sql = input.replace(/--> statement-breakpoint/g, ";");
  let out = "";
  let body: string | null = null;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const rest = sql.slice(i, i + 64);
    const tag = c === "$" ? /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(rest)?.[0] : undefined;
    if (tag !== undefined) {
      if (body === null) body = tag;
      else if (tag === body) body = null;
      out += " ";
      i += tag.length;
    } else if (rest.startsWith("--")) {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      out += " ";
    } else if (rest.startsWith("/*")) {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? sql.length : close + 2;
      out += " ";
    } else if (c === "'" || c === '"') {
      const close = closingQuote(sql, i, c);
      // Identifiers ("…") are always kept; literals only inside bodies.
      out += c === '"' || body !== null ? sql.slice(i, close + 1) : "''";
      i = close + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Lint one migration's SQL.
 *
 * @param file - label used in findings (repo-relative path).
 * @returns one finding per destructive statement (first matching rule).
 */
export function lintMigrationSql(file: string, sql: string): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const statements = stripCommentsAndStrings(sql)
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
  for (const statement of statements) {
    const rule = RULES.find((r) => r.pattern.test(statement));
    if (rule) findings.push({ file, rule: rule.id, statement: statement.slice(0, 200) });
  }
  return findings;
}

/** Whether a repo-relative path is a forward SQL migration the linter covers. */
export function isMigrationFile(path: string): boolean {
  return path.startsWith(`${MIGRATIONS_DIR}/`) && path.endsWith(".sql");
}

function git(args: readonly string[], cwd: string): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(proc.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(proc.stdout);
}

/**
 * Lint every migration ADDED between `sinceRef` and HEAD. Edits to
 * already-shipped migrations are not re-linted: the runner never re-applies
 * a migration whose file name it has recorded.
 *
 * @param sinceRef - previous release tag; null lints nothing (first release).
 */
export function lintMigrationsSince(sinceRef: string | null, repoRoot: string): ContractFinding[] {
  if (sinceRef === null) return [];
  const added = git(
    ["diff", "--name-only", "--diff-filter=A", `${sinceRef}..HEAD`, "--", MIGRATIONS_DIR],
    repoRoot,
  )
    .split("\n")
    .filter(isMigrationFile);
  return added.flatMap((f) => lintMigrationSql(f, readFileSync(resolve(repoRoot, f), "utf8")));
}

/**
 * Newest cms_admin migration name (without `.sql`), skipping the
 * 9999 RLS catch-all which is not a schema step.
 */
export function migrationHead(fileNames: readonly string[]): string {
  const head = fileNames
    .filter((f) => /^\d{4}_.+\.sql$/.test(f) && !f.startsWith("9999_"))
    .sort()
    .at(-1);
  if (!head) throw new Error(`no numbered migration in ${MIGRATIONS_DIR}/cms_admin`);
  return head.replace(/\.sql$/, "");
}

/** Print findings in a form both humans and the Actions log annotate. */
export function formatFindings(findings: readonly ContractFinding[]): string {
  return findings.map((f) => `  ${f.file}: [${f.rule}] ${f.statement}`).join("\n");
}

if (import.meta.main) {
  const { previousStableTag, readTags } = await import("./release-checks.ts");
  const repoRoot = resolve(import.meta.dir, "..");
  const sinceIdx = process.argv.indexOf("--since");
  const since =
    sinceIdx >= 0
      ? (process.argv[sinceIdx + 1] ?? null)
      : previousStableTag(readTags(repoRoot), null);
  const findings = lintMigrationsSince(since, repoRoot);
  if (findings.length === 0) {
    console.log(`no contract migrations since ${since ?? "(no previous tag)"}`);
  } else {
    console.log(`contract migrations since ${since}:\n${formatFindings(findings)}`);
    if (process.argv.includes("--fail-on-contract")) process.exit(1);
  }
}
