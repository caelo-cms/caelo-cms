// SPDX-License-Identifier: MPL-2.0

/**
 * Audit logging invariant: every P2 op writes an audit_events row.
 * Success paths → succeeded=true; failure paths → succeeded=false.
 * Sensitive fields (password) never appear in the hash pre-image.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "audit-test",
};

const TEST_EMAIL = "audit-test-user@example.com";

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

async function countAuditRows(url: string, operation: string, succeeded: boolean): Promise<number> {
  const sql = new SQL(url);
  try {
    const rows = (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return (await tx`
        SELECT count(*)::int AS c FROM audit_events
        WHERE operation = ${operation} AND succeeded = ${succeeded}
      `) as unknown as { c: number }[];
    })) as unknown as { c: number }[];
    return rows[0]?.c ?? 0;
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

describe("audit_events invariant", () => {
  it("auth.login success writes a succeeded=true audit row", async () => {
    await execute(registry, adapter, systemCtx, "users.create", {
      email: TEST_EMAIL,
      password: "audit test password",
      displayName: "Audit Test User",
      roleNames: ["editor"],
    });

    const before = await countAuditRows(ADMIN_URL, "auth.login", true);
    const login = await execute(registry, adapter, systemCtx, "auth.login", {
      email: TEST_EMAIL,
      password: "audit test password",
    });
    expect(login.ok).toBe(true);
    const after = await countAuditRows(ADMIN_URL, "auth.login", true);
    expect(after).toBe(before + 1);
  });

  it("auth.login failure writes a succeeded=false audit row", async () => {
    const before = await countAuditRows(ADMIN_URL, "auth.login", false);
    const bad = await execute(registry, adapter, systemCtx, "auth.login", {
      email: TEST_EMAIL,
      password: "WRONG",
    });
    expect(bad.ok).toBe(false);
    const after = await countAuditRows(ADMIN_URL, "auth.login", false);
    expect(after).toBe(before + 1);
  });

  it("users.create success writes a succeeded=true audit row", async () => {
    const before = await countAuditRows(ADMIN_URL, "users.create", true);
    // Wipe the existing user so the create test below works.
    await wipe(ADMIN_URL);
    const create = await execute(registry, adapter, systemCtx, "users.create", {
      email: TEST_EMAIL,
      password: "another audit password",
      displayName: "Again",
      roleNames: [],
    });
    expect(create.ok).toBe(true);
    const after = await countAuditRows(ADMIN_URL, "users.create", true);
    expect(after).toBe(before + 1);
  });
});
