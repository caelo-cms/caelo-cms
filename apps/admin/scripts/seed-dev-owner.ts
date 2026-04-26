// SPDX-License-Identifier: MPL-2.0

/**
 * Idempotent dev-owner seed for manual inspection.
 *
 * Why this exists: tests deliberately use scoped emails (e.g.
 * `auth-test-owner@example.com`) and clean themselves up, so a fresh DB has no
 * known login. Manual screenshot runs and Playwright debug sessions need a
 * stable account whose password they know. This script provides one without
 * touching the first-owner bootstrap path (which only runs when the users
 * table is empty and is a poor fit for repeatable dev seeds).
 *
 * Usage:
 *   bun run apps/admin/scripts/seed-dev-owner.ts
 *
 * Env:
 *   ADMIN_DATABASE_URL              required
 *   DEV_OWNER_EMAIL    (default dev-owner@example.com)
 *   DEV_OWNER_PASSWORD (default dev owner password)
 *
 * Re-running with the same email refreshes the password and re-attaches the
 * owner role; user_roles rows orphaned by an earlier integration test no
 * longer block manual login.
 */

import { hashPassword } from "@caelo/admin-core";
import { SQL } from "bun";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
if (!ADMIN_URL) {
  console.error("ADMIN_DATABASE_URL is required");
  process.exit(1);
}

const EMAIL = process.env["DEV_OWNER_EMAIL"] ?? "dev-owner@example.com";
const PASSWORD = process.env["DEV_OWNER_PASSWORD"] ?? "dev owner password";

const passwordHash = await hashPassword(PASSWORD);
const sql = new SQL(ADMIN_URL);
try {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");

    // Reuse an existing actor row for this email if one exists; otherwise mint
    // a new one. The id flows into both users.id and user_roles.user_id so
    // they all reference the same actor.
    const existing = (await tx`
      SELECT id::text AS id FROM users WHERE email = ${EMAIL}
    `) as unknown as { id: string }[];

    let actorId: string;
    if (existing[0]) {
      actorId = existing[0].id;
      await tx`UPDATE users SET password_hash = ${passwordHash}, deleted_at = NULL WHERE id = ${actorId}::uuid`;
    } else {
      const actor = (await tx`
        INSERT INTO actors (kind, display_name) VALUES ('human', 'Dev Owner')
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      const id = actor[0]?.id;
      if (!id) throw new Error("seed actor insert returned no row");
      actorId = id;
      await tx`
        INSERT INTO users (id, email, password_hash, is_first_owner)
        VALUES (${actorId}::uuid, ${EMAIL}, ${passwordHash}, false)
      `;
    }

    await tx`
      INSERT INTO user_roles (user_id, role_id)
      SELECT ${actorId}::uuid, r.id FROM roles r WHERE r.name = 'owner'
      ON CONFLICT DO NOTHING
    `;
  });
} finally {
  await sql.end();
}

console.log(`dev owner ready: ${EMAIL} / ${PASSWORD}`);
