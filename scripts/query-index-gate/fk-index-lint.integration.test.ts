// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1293 — every foreign key of the migrated cms_admin and cms_public
 * schemas has a non-partial index with the FK columns leading, or a
 * reasoned entry in fk-index-lint.ts. See docs/dev/query-index-gate.md.
 */

import { describe, expect, it } from "bun:test";
import { SQL } from "bun";
import {
  FK_EXEMPTIONS,
  FK_PENDING,
  type ForeignKeyRow,
  judgeForeignKeys,
  UNINDEXED_FOREIGN_KEYS_SQL,
} from "./fk-index-lint.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

async function unindexed(db: ForeignKeyRow["db"], url: string): Promise<ForeignKeyRow[]> {
  const sql = new SQL(url, { max: 1 });
  try {
    const rows = (await sql.unsafe(UNINDEXED_FOREIGN_KEYS_SQL)) as unknown as Omit<
      ForeignKeyRow,
      "db"
    >[];
    return rows.map((r) => ({ db, ...r }));
  } finally {
    await sql.end();
  }
}

describe("FK index lint (#1293)", () => {
  it("every foreign key has a usable index or a reasoned list entry, and no entry is stale", async () => {
    const fks = [
      ...(await unindexed("cms_admin", ADMIN_URL)),
      ...(await unindexed("cms_public", PUBLIC_URL)),
    ];
    const verdict = judgeForeignKeys(fks);
    // A failure names the FK: add `CREATE INDEX IF NOT EXISTS <table>_<cols>_idx
    // ON <table> (<cols>)` in a migration (not partial — the RI lookup carries
    // no WHERE), or an FK_EXEMPTIONS entry saying why the lookup never matters.
    expect(verdict.unexplained).toEqual([]);
    // A stale entry: the FK is indexed now or gone — delete the entry.
    expect(verdict.stale).toEqual([]);
  });

  it("fails a new FK without an index or with a partial one; `fk IS NOT NULL` counts", async () => {
    // Temporary tables live in this session's pg_temp schema, which the
    // catalog query reads like any other: the lint sees them as it would
    // a migration's new FK, and they vanish with the connection.
    const sql = new SQL(ADMIN_URL, { max: 1 });
    try {
      const conn = await sql.reserve();
      try {
        await conn.unsafe(`
          CREATE TEMP TABLE lint_parent (id int PRIMARY KEY);
          CREATE TEMP TABLE lint_child (id int, parent_id int REFERENCES lint_parent (id));
          CREATE TEMP TABLE lint_soft (id int, deleted_at timestamptz,
                                       parent_id int REFERENCES lint_parent (id));
          CREATE INDEX ON lint_soft (parent_id) WHERE deleted_at IS NULL;
          CREATE TEMP TABLE lint_indexed (parent_id int REFERENCES lint_parent (id), x int);
          CREATE INDEX ON lint_indexed (parent_id, x);
          CREATE TEMP TABLE lint_optional (parent_id int REFERENCES lint_parent (id));
          CREATE INDEX ON lint_optional (parent_id) WHERE parent_id IS NOT NULL;`);
        const rows = (await conn.unsafe(UNINDEXED_FOREIGN_KEYS_SQL)) as unknown as Omit<
          ForeignKeyRow,
          "db"
        >[];
        const verdict = judgeForeignKeys(
          rows.map((r) => ({ db: "cms_admin" as const, ...r })),
          [],
          [{ key: "cms_admin gone(x) -> lint_parent" }],
        );
        expect(verdict.unexplained.filter((k) => k.includes("lint_"))).toEqual([
          "cms_admin lint_child(parent_id) -> lint_parent",
          "cms_admin lint_soft(parent_id) -> lint_parent",
        ]);
        expect(verdict.stale).toEqual(["cms_admin gone(x) -> lint_parent"]);
      } finally {
        conn.release();
      }
    } finally {
      await sql.end();
    }
  });

  it("every exemption carries a reason", () => {
    for (const e of FK_EXEMPTIONS) expect(e.reason.length).toBeGreaterThan(40);
    expect(new Set(FK_PENDING.map((p) => p.key)).size).toBe(FK_PENDING.length);
  });
});
