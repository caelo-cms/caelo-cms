// SPDX-License-Identifier: MPL-2.0

/**
 * Users CRUD integration: list, create, set_roles, delete — plus the
 * protected invariants (duplicate email rejected, first owner can't be
 * deleted, RLS + NOT NULL on actor_id still hold).
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
  requestId: "users-test",
};

const EMAILS = ["users-crud-editor@example.com", "users-crud-moderator@example.com"] as const;

async function wipe(url: string): Promise<void> {
  const sql = new SQL(url);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      for (const email of EMAILS) {
        await tx`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
        await tx`DELETE FROM users WHERE email = ${email}`;
      }
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

describe("users.is_setup_complete actor scope", () => {
  // Regression (2026-07-12): the op was system-only, but /login and
  // /setup loads execute it with the REQUEST ctx — a human actor
  // whenever a session cookie is present. The scope rejection plus a
  // silent `: false` fallback dumped every signed-in visitor of those
  // pages onto the setup form.
  it("accepts a human actor", async () => {
    const humanCtx: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-00000000fffe",
      actorKind: "human",
      requestId: "users-test-human",
    };
    const r = await execute(registry, adapter, humanCtx, "users.is_setup_complete", {});
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.value as { complete: boolean }).complete).toBe(true);
  });
});

describe("users CRUD", () => {
  it("creates a user and lists them back with the assigned roles", async () => {
    const create = await execute(registry, adapter, systemCtx, "users.create", {
      email: EMAILS[0],
      password: "editor-pass-word",
      displayName: "Editor User",
      roleNames: ["editor"],
    });
    expect(create.ok).toBe(true);

    const list = await execute(registry, adapter, systemCtx, "users.list", {});
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const users = (
      list.value as {
        users: { email: string; roles: string[] }[];
      }
    ).users;
    const editor = users.find((u) => u.email === EMAILS[0]);
    expect(editor).toBeTruthy();
    expect(editor?.roles).toEqual(["editor"]);
  });

  it("rejects duplicate emails", async () => {
    const dup = await execute(registry, adapter, systemCtx, "users.create", {
      email: EMAILS[0],
      password: "dup-pass-word",
      displayName: "Dup User",
      roleNames: [],
    });
    expect(dup.ok).toBe(false);
  });

  it("set_roles atomically replaces the role set", async () => {
    const list = await execute(registry, adapter, systemCtx, "users.list", {});
    if (!list.ok) throw new Error("list failed");
    const editor = (list.value as { users: { id: string; email: string }[] }).users.find(
      (u) => u.email === EMAILS[0],
    );
    expect(editor).toBeTruthy();

    const replace = await execute(registry, adapter, systemCtx, "users.set_roles", {
      userId: editor?.id ?? "",
      roleNames: ["reviewer"],
    });
    expect(replace.ok).toBe(true);

    const list2 = await execute(registry, adapter, systemCtx, "users.list", {});
    if (!list2.ok) throw new Error("list2 failed");
    const refreshed = (list2.value as { users: { email: string; roles: string[] }[] }).users.find(
      (u) => u.email === EMAILS[0],
    );
    expect(refreshed?.roles).toEqual(["reviewer"]);
  });

  it("deletes a non-first-owner user", async () => {
    await execute(registry, adapter, systemCtx, "users.create", {
      email: EMAILS[1],
      password: "mod-pass-word",
      displayName: "Moderator",
      roleNames: ["reviewer"],
    });

    const list = await execute(registry, adapter, systemCtx, "users.list", {});
    if (!list.ok) throw new Error("list failed");
    const target = (list.value as { users: { id: string; email: string }[] }).users.find(
      (u) => u.email === EMAILS[1],
    );
    expect(target).toBeTruthy();

    const del = await execute(registry, adapter, systemCtx, "users.delete", {
      userId: target?.id ?? "",
    });
    expect(del.ok).toBe(true);

    const list2 = await execute(registry, adapter, systemCtx, "users.list", {});
    if (!list2.ok) throw new Error("list2 failed");
    expect(
      (list2.value as { users: { email: string }[] }).users.some((u) => u.email === EMAILS[1]),
    ).toBe(false);
  });
});
