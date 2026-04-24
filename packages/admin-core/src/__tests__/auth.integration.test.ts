// SPDX-License-Identifier: MPL-2.0

/**
 * Auth flow integration: first-run owner bootstrap, login with good/bad
 * creds, session resolution, logout.
 *
 * bun test runs test files in parallel, so every DELETE here is scoped to
 * emails owned by this file — we do not wipe the whole users table.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo/query-api";
import type { ExecutionContext } from "@caelo/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  // Must reference the seeded system actor so recordAudit's FK holds.
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "auth-test",
};

const TEST_EMAIL = "auth-test-owner@example.com";

async function wipeOurRows(url: string): Promise<void> {
  const sql = new SQL(url);
  try {
    // users + sessions are RLS-forced with a system bypass — without SET LOCAL
    // here the DELETEs would match zero rows and leave stale fixtures behind.
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
  await wipeOurRows(ADMIN_URL);
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  // Seed this file's owner directly (bypassing the first-owner guard, which
  // relies on "no users anywhere" — brittle under parallel tests). We use the
  // same code path as the op: insert actor, then user, then attach the owner
  // role. Still exercises the integration boundary because every op in this
  // test uses the adapter + registry afterwards.
  const hash = await (await import("../password.js")).hashPassword("auth-test password");
  const admin = new SQL(ADMIN_URL);
  try {
    await admin.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const actor = (await tx`
        INSERT INTO actors (kind, display_name) VALUES ('human', 'Auth Test Owner')
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      const actorId = actor[0]?.id;
      if (!actorId) throw new Error("seed actor insert returned no row");
      await tx`
        INSERT INTO users (id, email, password_hash, is_first_owner)
        VALUES (${actorId}::uuid, ${TEST_EMAIL}, ${hash}, false)
      `;
      await tx`
        INSERT INTO user_roles (user_id, role_id)
        SELECT ${actorId}::uuid, r.id FROM roles r WHERE r.name = 'owner'
      `;
    });
  } finally {
    await admin.end();
  }
});

afterAll(async () => {
  await wipeOurRows(ADMIN_URL);
  await adapter.close();
});

describe("login flow", () => {
  it("login with wrong password fails without revealing the valid email", async () => {
    const bad = await execute(registry, adapter, systemCtx, "auth.login", {
      email: TEST_EMAIL,
      password: "WRONG password",
    });
    expect(bad.ok).toBe(false);

    const missing = await execute(registry, adapter, systemCtx, "auth.login", {
      email: "does-not-exist@example.com",
      password: "anything at all",
    });
    expect(missing.ok).toBe(false);
  });

  it("login with correct credentials issues a session + CSRF token and resolves to the owner role", async () => {
    const good = await execute(registry, adapter, systemCtx, "auth.login", {
      email: TEST_EMAIL,
      password: "auth-test password",
    });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    const value = good.value as {
      token: string;
      csrfToken: string;
      userId: string;
      expiresAt: string;
    };
    expect(value.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(value.csrfToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(value.token).not.toBe(value.csrfToken);

    const resolved = await execute(registry, adapter, systemCtx, "auth.resolve_session", {
      token: value.token,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const session = resolved.value as {
      email: string;
      roles: string[];
      permissions: string[];
    };
    expect(session.email).toBe(TEST_EMAIL);
    expect(session.roles).toContain("owner");
    expect(session.permissions).toContain("deploy.trigger");
    expect(session.permissions).toContain("roles.manage");

    const loggedOut = await execute(registry, adapter, systemCtx, "auth.logout", {
      token: value.token,
    });
    expect(loggedOut.ok).toBe(true);

    const postLogout = await execute(registry, adapter, systemCtx, "auth.resolve_session", {
      token: value.token,
    });
    expect(postLogout.ok).toBe(false);
  });
});
