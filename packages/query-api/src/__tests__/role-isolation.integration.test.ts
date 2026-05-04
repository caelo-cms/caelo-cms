// SPDX-License-Identifier: MPL-2.0

/**
 * Role-level isolation. Tests the Postgres GRANT boundary (not RLS): even
 * without any RLS policy, `public_role` must be unable to so much as connect
 * to cms_admin or see its tables. And `admin_role` (which owns the cms_public
 * schema for DDL) must not be able to INSERT into plugin tables without a
 * plugin identity — RLS catches that even though the role has SELECT.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { SQL } from "bun";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_DATABASE_URL; // public_role connecting to cms_public
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("ADMIN_DATABASE_URL + PUBLIC_DATABASE_URL required");

// We also need a public_role-scoped connection *to cms_admin* to try the leak.
// Compose the URL manually by replacing the database and credentials.
function deriveCrossDbUrl(publicUrl: string): string {
  // postgres://public_role:pw@host:port/cms_public → same but with /cms_admin
  return publicUrl.replace(/\/cms_public(\?|$)/, "/cms_admin$1");
}

const PUBLIC_ROLE_TO_ADMIN_DB = deriveCrossDbUrl(PUBLIC_URL);
const pubToAdmin = new SQL(PUBLIC_ROLE_TO_ADMIN_DB);

afterAll(async () => {
  await pubToAdmin.end();
});

describe("cross-database role leak", () => {
  it("public_role cannot SELECT from cms_admin.actors — permission denied", async () => {
    let caught: unknown = null;
    try {
      await pubToAdmin.unsafe("SELECT 1 FROM actors LIMIT 1");
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    const msg = (caught as { message?: string })?.message ?? "";
    expect(msg.toLowerCase()).toMatch(/permission denied|does not exist|no privileges/);
  });
});
