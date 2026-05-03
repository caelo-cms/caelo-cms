// SPDX-License-Identifier: MPL-2.0

/**
 * End-to-end custom-role enforcement: create a custom role with a reduced
 * permission set, create a user, assign the role, log in as that user, resolve
 * the session and assert the flattened permission set is exactly the role's
 * permissions — no more, no less.
 *
 * Also exercises the Reviewer built-in: a user assigned only `reviewer` does
 * NOT have `deploy.trigger` or `roles.manage`.
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
  requestId: "cre-test",
};

const TRANSLATOR_EMAIL = "enforcement-translator@example.com";
const REVIEWER_EMAIL = "enforcement-reviewer@example.com";
const TRANSLATOR_ROLE = "translator_enforcement_test";
const TRANSLATOR_PASSWORD = "translator pass word";
const REVIEWER_PASSWORD = "reviewer pass word";

async function wipe(url: string): Promise<void> {
  const sql = new SQL(url);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`
        DELETE FROM sessions WHERE user_id IN
          (SELECT id FROM users WHERE email IN (${TRANSLATOR_EMAIL}, ${REVIEWER_EMAIL}))
      `;
      await tx`
        DELETE FROM user_roles WHERE user_id IN
          (SELECT id FROM users WHERE email IN (${TRANSLATOR_EMAIL}, ${REVIEWER_EMAIL}))
      `;
      await tx`DELETE FROM users WHERE email IN (${TRANSLATOR_EMAIL}, ${REVIEWER_EMAIL})`;
      await tx`DELETE FROM roles WHERE name = ${TRANSLATOR_ROLE} AND is_builtin = false`;
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

describe("custom role end-to-end enforcement", () => {
  it("user with a custom role has exactly that role's permissions", async () => {
    // 1. Create a custom role with a reduced permission set.
    const roleRes = await execute(registry, adapter, systemCtx, "roles.create", {
      name: TRANSLATOR_ROLE,
      description: "Translator — reduced rights",
      permissions: ["content.read", "translations.write"],
    });
    expect(roleRes.ok).toBe(true);

    // 2. Create a user.
    const createRes = await execute(registry, adapter, systemCtx, "users.create", {
      email: TRANSLATOR_EMAIL,
      password: TRANSLATOR_PASSWORD,
      displayName: "Test Translator",
      roleNames: [],
    });
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;
    const userId = (createRes.value as { userId: string }).userId;

    // 3. Assign the custom role via set_roles.
    const assignRes = await execute(registry, adapter, systemCtx, "users.set_roles", {
      userId,
      roleNames: [TRANSLATOR_ROLE],
    });
    expect(assignRes.ok).toBe(true);

    // 4. Log in and resolve the session.
    const login = await execute(registry, adapter, systemCtx, "auth.login", {
      email: TRANSLATOR_EMAIL,
      password: TRANSLATOR_PASSWORD,
    });
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    const token = (login.value as { token: string }).token;

    const resolved = await execute(registry, adapter, systemCtx, "auth.resolve_session", { token });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const session = resolved.value as { permissions: string[]; roles: string[] };

    // 5. Assert the resolved permission set equals exactly the role's grants.
    expect([...session.permissions].sort()).toEqual(["content.read", "translations.write"]);
    expect(session.roles).toEqual([TRANSLATOR_ROLE]);
    expect(session.permissions).not.toContain("deploy.trigger");
    expect(session.permissions).not.toContain("roles.manage");
    expect(session.permissions).not.toContain("users.manage");
  });

  it("Reviewer built-in has plugins.approve but NOT deploy.trigger or roles.manage", async () => {
    const createRes = await execute(registry, adapter, systemCtx, "users.create", {
      email: REVIEWER_EMAIL,
      password: REVIEWER_PASSWORD,
      displayName: "Test Reviewer",
      roleNames: ["reviewer"],
    });
    expect(createRes.ok).toBe(true);

    const login = await execute(registry, adapter, systemCtx, "auth.login", {
      email: REVIEWER_EMAIL,
      password: REVIEWER_PASSWORD,
    });
    expect(login.ok).toBe(true);
    if (!login.ok) return;

    const resolved = await execute(registry, adapter, systemCtx, "auth.resolve_session", {
      token: (login.value as { token: string }).token,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const session = resolved.value as { permissions: string[]; roles: string[] };

    expect(session.roles).toContain("reviewer");
    expect(session.permissions).toContain("plugins.approve");
    expect(session.permissions).toContain("content.read");
    // The key negatives — Reviewer must not have these
    expect(session.permissions).not.toContain("deploy.trigger");
    expect(session.permissions).not.toContain("roles.manage");
    expect(session.permissions).not.toContain("users.manage");
    expect(session.permissions).not.toContain("content.write");
  });
});
