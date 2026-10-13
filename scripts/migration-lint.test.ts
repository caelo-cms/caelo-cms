// SPDX-License-Identifier: MPL-2.0

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintMigrationSql, lintMigrationsSince, migrationHead } from "./migration-lint.ts";

const rules = (sql: string) => lintMigrationSql("m.sql", sql).map((f) => f.rule);

describe("lintMigrationSql", () => {
  it.each([
    ["DROP TABLE IF EXISTS experiments;", "drop-object"],
    ["drop schema legacy cascade;", "drop-object"],
    ["DROP TYPE block_kind;", "drop-object"],
    ["DROP MATERIALIZED VIEW stats;", "drop-object"],
    ["DROP FUNCTION plugin_scope();", "drop-object"],
    ["ALTER TABLE pages DROP COLUMN legacy_slug;", "drop-column"],
    // COLUMN is optional in Postgres.
    ["ALTER TABLE pages DROP legacy_slug;", "drop-column"],
    ["ALTER TABLE t DROP CONSTRAINT c, DROP COLUMN x;", "drop-column"],
    ["ALTER TYPE block_kind ADD VALUE 'x';", "alter-type"],
    ["ALTER TABLE pages RENAME COLUMN a TO b;", "rename"],
    ["ALTER TABLE pages RENAME TO documents;", "rename"],
    ["ALTER TABLE pages ALTER COLUMN weight TYPE bigint;", "alter-column-type"],
    ["ALTER TABLE pages ALTER COLUMN weight SET DATA TYPE bigint;", "alter-column-type"],
    ['ALTER TABLE pages ALTER COLUMN slug TYPE "varchar"(50);', "alter-column-type"],
    ["ALTER TABLE pages ALTER COLUMN slug TYPE public.slug_text;", "alter-column-type"],
    // Dynamic SQL in a DO block runs; its string is linted, not stripped.
    ["DO $$ BEGIN EXECUTE 'DROP TABLE pages'; END $$;", "drop-object"],
    ["DO $body$ BEGIN EXECUTE format('ALTER TABLE %I RENAME TO x', t); END $body$;", "rename"],
  ])("flags %s as %s", (sql, rule) => {
    expect(rules(sql)).toEqual([rule]);
  });

  it.each([
    "CREATE TABLE pages (id uuid primary key);",
    "ALTER TABLE pages ADD COLUMN weight int;",
    'DROP POLICY IF EXISTS "pages_rw" ON pages;',
    "ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_slug_key;",
    "DROP INDEX IF EXISTS pages_slug_idx;",
    "DROP TRIGGER IF EXISTS t ON pages;",
    "ALTER TABLE pages ALTER COLUMN weight DROP DEFAULT;",
    "ALTER TABLE pages ALTER COLUMN weight DROP NOT NULL;",
    "ALTER TABLE pages ADD COLUMN type text;",
    "ALTER TABLE pages ALTER COLUMN type SET NOT NULL;",
    "-- we used to DROP TABLE pages here\nSELECT 1;",
    "/* RENAME later */ SELECT 1;",
    "INSERT INTO notes (body) VALUES ('please DROP TABLE x; and RENAME it');",
    "DO $$ BEGIN EXECUTE 'DROP POLICY IF EXISTS p ON pages'; END $$;",
  ])("does not flag %s", (sql) => {
    expect(rules(sql)).toEqual([]);
  });

  it("reports one finding per statement across breakpoints", () => {
    const sql =
      "CREATE TABLE a (id int);\n--> statement-breakpoint\nDROP TABLE b;\n--> statement-breakpoint\nALTER TABLE c RENAME TO d;";
    expect(rules(sql)).toEqual(["drop-object", "rename"]);
  });
});

describe("migrationHead", () => {
  it("returns the newest numbered migration, skipping the 9999 RLS file and meta", () => {
    expect(
      migrationHead([
        "0001_a.sql",
        "0262_tool_approval_branch.sql",
        "9999_rls_policies.sql",
        "meta",
      ]),
    ).toBe("0262_tool_approval_branch");
  });
});

describe("lintMigrationsSince (git)", () => {
  const repo = mkdtempSync(join(tmpdir(), "caelo-migration-lint-"));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr));
  };
  const dir = join(repo, "packages/migrations/migrations/cms_admin");

  it("lints only migrations added after the tag", () => {
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "0001_old.sql"), "DROP TABLE shipped_long_ago;");
    git("add", ".");
    git("commit", "-qm", "base");
    git("tag", "v0.1.0");
    writeFileSync(join(dir, "0002_new.sql"), "ALTER TABLE pages DROP COLUMN x;");
    writeFileSync(join(dir, "0003_expand.sql"), "ALTER TABLE pages ADD COLUMN y int;");
    git("add", ".");
    git("commit", "-qm", "next");

    const findings = lintMigrationsSince("v0.1.0", repo);
    expect(findings.map((f) => [f.file, f.rule])).toEqual([
      ["packages/migrations/migrations/cms_admin/0002_new.sql", "drop-column"],
    ]);
    expect(lintMigrationsSince(null, repo)).toEqual([]);
  });
});
