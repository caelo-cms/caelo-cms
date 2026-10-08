// SPDX-License-Identifier: MPL-2.0
import { SQL } from "bun";

/**
 * Make `actorId` a real, active user holding a built-in role. #589: a §11.A
 * executor checks the APPROVING human's permissions through their roles, so
 * a test that approves as a human needs a user row behind the context — a
 * bare `actorKind: "human"` id no longer passes the gate. Idempotent.
 */
export async function ensureRoleUser(
  adminUrl: string,
  actorId: string,
  role: "owner" | "editor" | "reviewer",
): Promise<void> {
  const sql = new SQL(adminUrl);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`INSERT INTO actors (id, kind, display_name) VALUES (${actorId}::uuid, 'human', ${`test-${role}`}) ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO users (id, email, password_hash) VALUES (${actorId}::uuid, ${`${actorId}@role-user.test`}, 'test-only') ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO user_roles (user_id, role_id) SELECT ${actorId}::uuid, id FROM roles WHERE name = ${role} ON CONFLICT DO NOTHING`;
    });
  } finally {
    await sql.end();
  }
}
