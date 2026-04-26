// SPDX-License-Identifier: MPL-2.0

/**
 * RLS coverage for the P4 snapshot tables. Mirrors the P3 content-rls test:
 * a direct SQL connection that does not call `set_config('caelo.actor_kind',
 * ...)` matches no rows on the new tables, even though it owns the database.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL required");

const DESCRIPTION = "p4-rls-snapshot-test-row";

let seededSnapshotId = "";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM site_snapshots WHERE description = ${DESCRIPTION}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = (await tx`
        INSERT INTO site_snapshots (actor_id, op_kind, description)
        VALUES ('00000000-0000-0000-0000-00000000ffff'::uuid, 'unknown', ${DESCRIPTION})
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      seededSnapshotId = rows[0]?.id ?? "";
    });
  } finally {
    await sql.end();
  }
});

afterAll(async () => {
  await wipe();
});

describe("P4 snapshot RLS", () => {
  it("anonymous (no caelo.actor_kind) sees zero rows on every snapshot table", async () => {
    const sql = new SQL(ADMIN_URL!);
    try {
      await sql.begin(async (tx) => {
        const ss = (await tx`SELECT count(*)::int AS c FROM site_snapshots`) as unknown as {
          c: number;
        }[];
        expect(ss[0]?.c).toBe(0);
        const ms = (await tx`SELECT count(*)::int AS c FROM module_snapshots`) as unknown as {
          c: number;
        }[];
        expect(ms[0]?.c).toBe(0);
        const ts = (await tx`SELECT count(*)::int AS c FROM template_snapshots`) as unknown as {
          c: number;
        }[];
        expect(ts[0]?.c).toBe(0);
        const ps = (await tx`SELECT count(*)::int AS c FROM page_snapshots`) as unknown as {
          c: number;
        }[];
        expect(ps[0]?.c).toBe(0);
        const pls = (await tx`SELECT count(*)::int AS c FROM page_layout_snapshots`) as unknown as {
          c: number;
        }[];
        expect(pls[0]?.c).toBe(0);
      });
    } finally {
      await sql.end();
    }
  });

  it("authenticated session (any actor_kind) sees the seeded site_snapshot", async () => {
    expect(seededSnapshotId).not.toBe("");
    const sql = new SQL(ADMIN_URL!);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'human'");
        const rows =
          (await tx`SELECT count(*)::int AS c FROM site_snapshots WHERE description = ${DESCRIPTION}`) as unknown as {
            c: number;
          }[];
        expect(rows[0]?.c).toBe(1);
      });
    } finally {
      await sql.end();
    }
  });

  it("anonymous insert is rejected by RLS", async () => {
    const sql = new SQL(ADMIN_URL!);
    let threw = false;
    try {
      await sql.begin(async (tx) => {
        // No SET LOCAL caelo.actor_kind — the WITH CHECK should reject.
        await tx`
          INSERT INTO site_snapshots (actor_id, description)
          VALUES ('00000000-0000-0000-0000-00000000ffff'::uuid, 'should-fail')
        `;
      });
    } catch {
      threw = true;
    } finally {
      await sql.end();
    }
    expect(threw).toBe(true);
  });
});
