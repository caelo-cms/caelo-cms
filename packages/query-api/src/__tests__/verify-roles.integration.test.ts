// SPDX-License-Identifier: MPL-2.0

/**
 * `DatabaseAdapter.verifyRoles()` startup self-check. Passes when the adapter
 * is constructed with the right role-to-database pairings, fails loudly when
 * someone swaps a URL — the single misconfiguration that RLS itself cannot
 * detect because RLS still works correctly "under the wrong role".
 *
 * Each case creates its own adapter and closes it immediately in a try/finally
 * so the failure-case pools don't leak into later tests.
 */

import { describe, expect, it } from "bun:test";
import { DatabaseAdapter } from "../index.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_ROLE_URL = process.env.PUBLIC_DATABASE_URL;
const PUBLIC_ADMIN_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_ROLE_URL || !PUBLIC_ADMIN_URL) {
  throw new Error("all three DB URLs required for verify-roles tests");
}

async function withAdapter<T>(
  config: ConstructorParameters<typeof DatabaseAdapter>[0],
  fn: (a: DatabaseAdapter) => Promise<T>,
): Promise<T> {
  const a = new DatabaseAdapter(config);
  try {
    return await fn(a);
  } finally {
    await a.close();
  }
}

describe("DatabaseAdapter.verifyRoles()", () => {
  it("passes when admin_role → cms_admin and public_role → cms_public", async () => {
    await withAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_ROLE_URL }, (a) =>
      a.verifyRoles(),
    );
  });

  it("passes when admin_role is used for both (admin-side reads of cms_public)", async () => {
    await withAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_ADMIN_URL }, (a) =>
      a.verifyRoles(),
    );
  });

  it("throws when adminDatabaseUrl actually points at cms_public (the misconfig it's designed to catch)", async () => {
    await withAdapter(
      { adminDatabaseUrl: PUBLIC_ADMIN_URL, publicDatabaseUrl: PUBLIC_ROLE_URL },
      async (a) => {
        await expect(a.verifyRoles()).rejects.toThrow(/admin pool expected/);
      },
    );
  });

  it("throws when publicDatabaseUrl points at cms_admin", async () => {
    await withAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: ADMIN_URL }, async (a) => {
      await expect(a.verifyRoles()).rejects.toThrow(/public pool expected database cms_public/);
    });
  });

  it("memoises — subsequent calls return the same promise", async () => {
    await withAdapter(
      { adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_ROLE_URL },
      async (a) => {
        const p1 = a.verifyRoles();
        const p2 = a.verifyRoles();
        expect(p1).toBe(p2);
        await p1;
      },
    );
  });
});
