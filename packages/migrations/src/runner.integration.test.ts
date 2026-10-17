// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #635 — the migration runner enforces release ordering for contract
 * migrations against a real Postgres: an install that skips the expand
 * release is refused before anything is applied (so a retry of the same
 * jump is refused again); the two-step upgrade and a fresh install apply.
 *
 * Runs in a scratch database of its own with fixture migrations, so the
 * shared test databases are untouched.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { MigrationRunOrderError } from "./run-order.js";
import { runMigrations } from "./runner.js";

const env = process.env;
const missing = ["POSTGRES_USER", "POSTGRES_PORT"].filter((name) => !env[name]);
if (missing.length > 0) throw new Error(`${missing.join(", ")} required (see .env.example)`);

const DB = "caelo_run_order_test";
const superuserUrl = (db: string) => {
  const u = new URL(`postgres://localhost/${db}`);
  u.hostname = env.PGHOST ?? "localhost";
  u.port = env.POSTGRES_PORT as string;
  u.username = env.POSTGRES_USER as string;
  if (env.POSTGRES_PASSWORD) u.password = env.POSTGRES_PASSWORD;
  return u.toString();
};

const BASE = "0001_base.sql";
const EXPAND = "0002_expand.sql";
const CONTRACT = "0003_contract.sql";
const BODIES: Record<string, string> = {
  [BASE]: "CREATE TABLE legacy (id int);",
  [EXPAND]: "CREATE TABLE replacement (id int);",
  [CONTRACT]: [
    "-- SPDX-License-Identifier: MPL-2.0",
    "-- caelo:contract drops the table the previous release reads",
    `-- caelo:requires-earlier-run ${EXPAND}`,
    "",
    "DROP TABLE legacy;",
  ].join("\n"),
};

let root: string;
let su: SQL;
let db: SQL;

/** A migrations directory holding `names` (one release's files). */
function release(names: string[]): string {
  const dir = mkdtempSync(join(root, "release-"));
  for (const name of names) writeFileSync(join(dir, name), BODIES[name] as string);
  return dir;
}

async function recorded(): Promise<string[]> {
  const rows = (await db`SELECT hash FROM __drizzle_migrations ORDER BY id`) as { hash: string }[];
  return rows.map((r) => r.hash);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "caelo-run-order-"));
  su = new SQL(superuserUrl("postgres"), { max: 1 });
});

beforeEach(async () => {
  await db?.end();
  await su.unsafe(`DROP DATABASE IF EXISTS ${DB}`);
  await su.unsafe(`CREATE DATABASE ${DB}`);
  db = new SQL(superuserUrl(DB), { max: 1 });
});

afterAll(async () => {
  await db?.end();
  await su.unsafe(`DROP DATABASE IF EXISTS ${DB}`);
  await su.end();
  rmSync(root, { recursive: true, force: true });
});

describe("migration run ordering (#635)", () => {
  it("refuses an install that jumps past the expand release, before applying anything — every time", async () => {
    await runMigrations(db, release([BASE]));
    const contractRelease = release([BASE, EXPAND, CONTRACT]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await runMigrations(db, contractRelease).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MigrationRunOrderError);
      expect(String(error)).toContain(`${CONTRACT} needs ${EXPAND} applied by an EARLIER`);
      expect(await recorded()).toEqual([BASE]);
    }
    const [legacy] = (await db`SELECT to_regclass('legacy') AS t`) as { t: string | null }[];
    expect(legacy?.t).toBe("legacy");
  });

  it("applies the contract migration after the expand release ran", async () => {
    await runMigrations(db, release([BASE]));
    expect(await runMigrations(db, release([BASE, EXPAND]))).toEqual([EXPAND]);
    expect(await runMigrations(db, release([BASE, EXPAND, CONTRACT]))).toEqual([CONTRACT]);
    expect(await recorded()).toEqual([BASE, EXPAND, CONTRACT]);
  });

  it("applies everything in one run on a fresh install", async () => {
    expect(await runMigrations(db, release([BASE, EXPAND, CONTRACT]))).toEqual([
      BASE,
      EXPAND,
      CONTRACT,
    ]);
  });
});
