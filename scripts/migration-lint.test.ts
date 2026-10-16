// SPDX-License-Identifier: MPL-2.0

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lintMigrationSql,
  lintMigrationsSince,
  migrationHead,
  outOfOrderMigrations,
  outOfOrderMigrationsSince,
} from "./migration-lint.ts";

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
    "ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_parent_fkey;",
    "ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_pkey;",
    "DROP INDEX IF EXISTS pages_slug_idx;",
    // A UNIQUE index / constraint dropped and recreated under the same name
    // keeps the guarantee.
    "DROP INDEX IF EXISTS pages_slug_uidx; CREATE UNIQUE INDEX pages_slug_uidx ON pages (slug, x);",
    "ALTER TABLE t DROP CONSTRAINT t_slug_key; ALTER TABLE t ADD CONSTRAINT t_slug_key UNIQUE (slug, x);",
    "-- mentions caelo:contract only in a comment deeper in the file\nSELECT 1;",
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

  it.each([
    ["DROP INDEX IF EXISTS pages_slug_branch_uidx;"],
    ["ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_slug_key;"],
    ["ALTER TABLE pages DROP CONSTRAINT pages_slug_locale_unique;"],
    ['DROP INDEX CONCURRENTLY IF EXISTS "public"."media_sha_uniq";'],
  ])("flags a dropped UNIQUE guarantee: %s", (sql) => {
    expect(rules(sql)).toEqual(["drop-unique"]);
  });

  it("counts a migration that declares itself contract, with its reason", () => {
    const sql =
      "-- SPDX-License-Identifier: MPL-2.0\n-- caelo:contract the old image treats slugs as unique\n--\nCREATE INDEX x ON t (a);";
    expect(lintMigrationSql("m.sql", sql)).toEqual([
      { file: "m.sql", rule: "marked-contract", statement: "the old image treats slugs as unique" },
    ]);
    // Only the leading comment header counts.
    expect(rules("SELECT 1;\n-- caelo:contract too late\nSELECT 2;")).toEqual([]);
    expect(() => lintMigrationSql("m.sql", "-- caelo:contract\nSELECT 1;")).toThrow(
      /needs a reason/,
    );
  });

  it("keeps string and comment boundaries apart (`--` inside a string, quote inside a comment)", () => {
    expect(
      rules(
        "INSERT INTO t VALUES ('-- label');\nDROP TABLE users;\nINSERT INTO t VALUES ('other');",
      ),
    ).toEqual(["drop-object"]);
    expect(rules("-- it's fine\nDROP TABLE users;\nSELECT 'x';")).toEqual(["drop-object"]);
    expect(rules("/* don't */ ALTER TABLE t RENAME TO u;")).toEqual(["rename"]);
    expect(rules('ALTER TABLE "we--ird" DROP COLUMN c;')).toEqual(["drop-column"]);
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

describe("outOfOrderMigrations (#635: 0282 arriving after a shipped 0283)", () => {
  it("flags a migration added below the previous release's head, per database", () => {
    expect(
      outOfOrderMigrations(
        {
          cms_admin: ["0281_a.sql", "0283_b.sql", "9999_rls_policies.sql", "meta"],
          cms_public: ["0280_c.sql"],
        },
        { cms_admin: ["0282_late.sql", "0284_ok.sql"], cms_public: ["0281_ok.sql"] },
      ),
    ).toEqual([{ file: "cms_admin/0282_late.sql", head: "cms_admin/0283_b.sql" }]);
  });

  it("reads the previous release from git", () => {
    const repo = mkdtempSync(join(tmpdir(), "caelo-migration-order-"));
    try {
      const git = (...args: string[]) => {
        const p = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
        if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr));
      };
      const dir = join(repo, "packages/migrations/migrations/cms_admin");
      git("init", "-q");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "t");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "0281_a.sql"), "SELECT 1;");
      writeFileSync(join(dir, "0283_b.sql"), "SELECT 1;");
      git("add", ".");
      git("commit", "-qm", "base");
      git("tag", "v0.1.0");
      writeFileSync(join(dir, "0282_late.sql"), "SELECT 1;");
      writeFileSync(join(dir, "0284_ok.sql"), "SELECT 1;");
      git("add", ".");
      git("commit", "-qm", "next");
      expect(outOfOrderMigrationsSince("v0.1.0", repo)).toEqual([
        { file: "cms_admin/0282_late.sql", head: "cms_admin/0283_b.sql" },
      ]);
      expect(outOfOrderMigrationsSince(null, repo)).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
