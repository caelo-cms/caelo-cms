// SPDX-License-Identifier: MPL-2.0

/**
 * #748 — `plugins.locale_aware` (core i18n leftover, no readers since
 * epic #380) is gone from a migrated database.
 */

import { describe, expect, it } from "bun:test";
import { SQL } from "bun";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL required");

describe("dropped plugin columns", () => {
  it("plugins.locale_aware no longer exists", async () => {
    const sql = new SQL(ADMIN_URL);
    try {
      const rows = (await sql`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'plugins' AND column_name = 'locale_aware'
      `) as unknown[];
      expect(rows).toEqual([]);
    } finally {
      await sql.end();
    }
  });
});
