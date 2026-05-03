// SPDX-License-Identifier: MPL-2.0

/**
 * Soft-delete preserves audit history. Verifies:
 *   1. users.delete sets deleted_at instead of removing the row.
 *   2. users.list filters out soft-deleted users by default.
 *   3. users.list({ includeDeleted: true }) shows them with deletedAt set.
 *   4. auth.login fails for a soft-deleted user.
 *   5. audit_events rows authored by the deleted user are still present.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "soft-delete-test",
};

const TEST_EMAIL = "soft-delete-target@example.com";

async function wipe(url: string): Promise<void> {
  const sql = new SQL(url);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ${TEST_EMAIL})`;
      await tx`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = ${TEST_EMAIL})`;
      await tx`DELETE FROM users WHERE email = ${TEST_EMAIL}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe(ADMIN_URL);
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe(ADMIN_URL);
  await adapter.close();
});

async function countAuditFor(actorId: string): Promise<number> {
  const sql = new SQL(ADMIN_URL!);
  try {
    const rows = (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return (await tx`
        SELECT count(*)::int AS c FROM audit_events WHERE actor_id = ${actorId}::uuid
      `) as unknown as { c: number }[];
    })) as unknown as { c: number }[];
    return rows[0]?.c ?? 0;
  } finally {
    await sql.end();
  }
}

describe("soft-delete users", () => {
  it("creates → logs in → deletes (soft) → cannot log in → row hidden by default but visible with includeDeleted", async () => {
    const create = await execute(registry, adapter, systemCtx, "users.create", {
      email: TEST_EMAIL,
      password: "soft-delete password",
      displayName: "Soft Target",
      roleNames: ["editor"],
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    const userId = (create.value as { userId: string }).userId;

    // Initial login works → produces an auth.login audit row.
    const initialLogin = await execute(registry, adapter, systemCtx, "auth.login", {
      email: TEST_EMAIL,
      password: "soft-delete password",
    });
    expect(initialLogin.ok).toBe(true);

    const auditCountBefore = await countAuditFor(userId);
    expect(auditCountBefore).toBeGreaterThan(0);

    // Delete is soft.
    const del = await execute(registry, adapter, systemCtx, "users.delete", { userId });
    expect(del.ok).toBe(true);

    // Audit history preserved.
    const auditCountAfter = await countAuditFor(userId);
    expect(auditCountAfter).toBeGreaterThanOrEqual(auditCountBefore);

    // Default users.list hides the soft-deleted row.
    const list = await execute(registry, adapter, systemCtx, "users.list", {});
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const visible = (list.value as { users: { email: string }[] }).users.find(
      (u) => u.email === TEST_EMAIL,
    );
    expect(visible).toBeUndefined();

    // includeDeleted=true reveals it with deletedAt populated.
    const listAll = await execute(registry, adapter, systemCtx, "users.list", {
      includeDeleted: true,
    });
    expect(listAll.ok).toBe(true);
    if (!listAll.ok) return;
    const found = (
      listAll.value as { users: { email: string; deletedAt: string | null }[] }
    ).users.find((u) => u.email === TEST_EMAIL);
    expect(found).toBeTruthy();
    expect(found?.deletedAt).not.toBeNull();

    // Login is denied even with the right password.
    const post = await execute(registry, adapter, systemCtx, "auth.login", {
      email: TEST_EMAIL,
      password: "soft-delete password",
    });
    expect(post.ok).toBe(false);
  });
});
