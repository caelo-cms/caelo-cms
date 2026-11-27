// SPDX-License-Identifier: MPL-2.0

/**
 * Fixture SQL as the system actor, on a raw connection of its own: outside
 * every adapter transaction, so it carries no operation tag and the query
 * index gate ignores it (docs/dev/query-index-gate.md). For a test's own
 * cleanups and assertions; what the code under test runs goes through
 * operations, where the gate sees it.
 */

import { SQL } from "bun";

/**
 * Runs `fn` in one transaction as the system actor.
 *
 * @param url the database, `ADMIN_DATABASE_URL` (cms_admin) when omitted.
 */
export async function rawSystemSql<T>(
  fn: (tx: Bun.SQL) => Promise<T>,
  url = process.env.ADMIN_DATABASE_URL,
): Promise<T> {
  if (!url) throw new Error("rawSystemSql: ADMIN_DATABASE_URL is required");
  const db = new SQL(url);
  try {
    return await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await db.end();
  }
}
