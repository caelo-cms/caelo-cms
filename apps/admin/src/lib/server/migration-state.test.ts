// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrationState, shippedMigrations, shippedMigrationsRoot } from "./migration-state.js";

describe("migrationState", () => {
  const shipped = ["0001_a.sql", "0002_b.sql", "0003_c.sql", "9999_rls_policies.sql"];

  it("reports nothing pending and the newest real migration as head when all are applied", () => {
    expect(migrationState(shipped, [...shipped])).toEqual({ head: "0003_c.sql", pending: 0 });
  });

  it("counts shipped files the database has not recorded", () => {
    expect(migrationState(shipped, ["0001_a.sql", "9999_rls_policies.sql"])).toEqual({
      head: "0001_a.sql",
      pending: 2,
    });
  });

  it("ignores applied files this image does not ship (a newer release ran before)", () => {
    expect(migrationState(["0001_a.sql"], ["0001_a.sql", "0002_future.sql"])).toEqual({
      head: "0001_a.sql",
      pending: 0,
    });
  });

  it("has no head on an empty database", () => {
    expect(migrationState(shipped, [])).toEqual({ head: null, pending: 4 });
  });
});

describe("shippedMigrationsRoot / shippedMigrations", () => {
  it("finds the migrations above the working directory and lists the .sql files sorted", () => {
    const root = mkdtempSync(join(tmpdir(), "caelo-mig-"));
    try {
      const dir = join(root, "packages", "migrations", "migrations", "cms_admin");
      mkdirSync(dir, { recursive: true });
      mkdirSync(join(root, "apps", "admin"), { recursive: true });
      for (const f of ["0002_b.sql", "0001_a.sql", "notes.md"]) writeFileSync(join(dir, f), "");
      const found = shippedMigrationsRoot(join(root, "apps", "admin"));
      expect(shippedMigrations(found, "cms_admin")).toEqual(["0001_a.sql", "0002_b.sql"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when the image carries no migrations", () => {
    const root = mkdtempSync(join(tmpdir(), "caelo-mig-"));
    try {
      expect(() => shippedMigrationsRoot(root)).toThrow(/no packages\/migrations\/migrations/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
