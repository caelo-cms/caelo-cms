// SPDX-License-Identifier: MPL-2.0

/**
 * issue #112 — regression pin for the preload's CASCADE-reachability
 * invariant.
 *
 * The preload TRUNCATEs every table outside ADMIN_PRESERVE /
 * DELETE_NOT_TRUNCATE with CASCADE — and CASCADE truncates every table
 * that references a truncated one, ALLOWLIST OR NOT. The themes wipe
 * happened exactly this way: `themes` (seed-bearing) held SET NULL FKs
 * to `media_assets` (truncate set), so truncating media_assets emptied
 * themes on every test run and left dev installs with no active theme.
 *
 * The invariant that keeps protected tables actually protected:
 * every outbound FK from a protected table (PRESERVE ∪
 * DELETE_NOT_TRUNCATE) must target another protected table. This test
 * derives the FK graph from pg_constraint on the real database, so the
 * next themes-style hole fails CI instead of silently emptying seeds.
 */

import { describe, expect, it } from "bun:test";
import { SQL } from "bun";
import {
  ADMIN_PRESERVE,
  DELETE_NOT_TRUNCATE,
  PUBLIC_PRESERVE,
} from "../test-preload.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

interface FkEdge {
  readonly source_table: string;
  readonly target_table: string;
}

async function foreignKeyEdges(url: string): Promise<FkEdge[]> {
  const sql = new SQL(url, { max: 2 });
  try {
    return (await sql`
      SELECT src.relname AS source_table, tgt.relname AS target_table
      FROM pg_constraint c
      JOIN pg_class src ON src.oid = c.conrelid
      JOIN pg_class tgt ON tgt.oid = c.confrelid
      JOIN pg_namespace n ON n.oid = src.relnamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'
    `) as unknown as FkEdge[];
  } finally {
    await sql.end();
  }
}

async function tableNames(url: string): Promise<Set<string>> {
  const sql = new SQL(url, { max: 2 });
  try {
    const rows = (await sql`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `) as unknown as { tablename: string }[];
    return new Set(rows.map((r) => r.tablename));
  } finally {
    await sql.end();
  }
}

describe("test-preload protected-table invariants (issue #112)", () => {
  it("cms_admin: no protected table references a truncate-set table (CASCADE reachability)", async () => {
    const protectedTables = new Set([...ADMIN_PRESERVE, ...DELETE_NOT_TRUNCATE]);
    const edges = await foreignKeyEdges(ADMIN_URL!);
    const holes = edges.filter(
      (e) => protectedTables.has(e.source_table) && !protectedTables.has(e.target_table),
    );
    expect(
      holes,
      `These FKs make a protected table CASCADE-reachable from the truncate set — ` +
        `add the target to ADMIN_PRESERVE or DELETE_NOT_TRUNCATE in scripts/test-preload.ts: ` +
        JSON.stringify(holes),
    ).toEqual([]);
  });

  it("cms_admin: every allowlisted table actually exists (catches renames that silently unprotect)", async () => {
    const existing = await tableNames(ADMIN_URL!);
    const stale = [...ADMIN_PRESERVE, ...DELETE_NOT_TRUNCATE].filter((t) => !existing.has(t));
    expect(
      stale,
      `Allowlist entries with no matching table — a rename left the real table unprotected: ${JSON.stringify(stale)}`,
    ).toEqual([]);
  });

  it("cms_public: same invariants for the public DB", async () => {
    const edges = await foreignKeyEdges(PUBLIC_URL!);
    const holes = edges.filter(
      (e) => PUBLIC_PRESERVE.has(e.source_table) && !PUBLIC_PRESERVE.has(e.target_table),
    );
    expect(holes).toEqual([]);

    const existing = await tableNames(PUBLIC_URL!);
    const stale = [...PUBLIC_PRESERVE].filter((t) => !existing.has(t));
    expect(stale).toEqual([]);
  });
});
