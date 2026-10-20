// SPDX-License-Identifier: MPL-2.0

/**
 * PR #863 — account invariants an Owner (or the AI, through a proposal)
 * must not be able to break:
 *
 *   M-10  the first Owner always keeps the `owner` role, and the built-in
 *         `owner` role's permissions cannot be edited — on the direct op,
 *         at propose time, AND when an already-queued proposal is approved.
 *   M-09  deleting a user revokes their MCP bearer tokens in the same
 *         transaction, and a token whose user is deleted never resolves.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { mcpTokenAuthErrorMessage, resolveMcpToken } from "../ops/security/mcp_tokens.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "owner-invariants-test",
};

const EMAILS = {
  first: "inv-first-owner@example.com",
  second: "inv-second-owner@example.com",
  leaver: "inv-leaver@example.com",
  legacy: "inv-legacy@example.com",
} as const;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let firstOwnerId: string;
let secondOwnerId: string;
let ownerRoleId: string;
let customRoleId: string;

async function asSystem<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await asSystem(async (tx) => {
    const emails = Object.values(EMAILS);
    await tx`DELETE FROM mcp_tokens WHERE actor_id IN (SELECT id FROM users WHERE email IN ${tx(emails)})`;
    await tx`DELETE FROM user_pending_actions WHERE user_id IN (SELECT id FROM users WHERE email IN ${tx(emails)})`;
    await tx`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email IN ${tx(emails)})`;
    await tx`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email IN ${tx(emails)})`;
    await tx`DELETE FROM users WHERE email IN ${tx(emails)}`;
    await tx`DELETE FROM role_pending_actions WHERE role_id IN (SELECT id FROM roles WHERE name = 'inv-custom')`;
    await tx`DELETE FROM roles WHERE name = 'inv-custom'`;
  });
}

function ok<T>(r: { ok: boolean; value?: unknown; error?: unknown }): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value as T;
}

function errMessage(r: { ok: boolean; error?: unknown }): string {
  expect(r.ok).toBe(false);
  return String((r.error as { message?: string } | undefined)?.message ?? "");
}

async function rolesOf(userId: string): Promise<string[]> {
  const rows = (await asSystem(
    (tx) => tx`
      SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ${userId}::uuid ORDER BY r.name`,
  )) as { name: string }[];
  return rows.map((r) => r.name);
}

async function permissionsOf(roleId: string): Promise<string[]> {
  const rows = (await asSystem(
    (tx) => tx`
      SELECT p.name FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ${roleId}::uuid ORDER BY p.name`,
  )) as { name: string }[];
  return rows.map((r) => r.name);
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipe();
  await asSystem((tx) => tx`DELETE FROM owner_bootstrap_tokens`);
  await asSystem((tx) => tx`UPDATE users SET deleted_at = now() WHERE deleted_at IS NULL`);

  const first = await execute(registry, adapter, systemCtx, "users.create_first_owner", {
    email: EMAILS.first,
    password: "quarry-saffron-dune-41",
    displayName: "First Owner",
  });
  firstOwnerId = ok<{ userId: string }>(first).userId;
  const second = await execute(registry, adapter, systemCtx, "users.create", {
    email: EMAILS.second,
    password: "harbor-thistle-maple-17",
    displayName: "Second Owner",
    roleNames: ["owner"],
  });
  secondOwnerId = ok<{ userId: string }>(second).userId;

  const roles = ok<{ roles: { id: string; name: string; isBuiltin: boolean }[] }>(
    await execute(registry, adapter, systemCtx, "roles.list", {}),
  ).roles;
  const owner = roles.find((r) => r.name === "owner" && r.isBuiltin);
  if (!owner) throw new Error("built-in owner role missing from the seed");
  ownerRoleId = owner.id;
  customRoleId = ok<{ roleId: string }>(
    await execute(registry, adapter, systemCtx, "roles.create", {
      name: "inv-custom",
      permissions: ["content.read"],
    }),
  ).roleId;
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("M-10 — the first Owner keeps the owner role", () => {
  it("users.set_roles refuses to drop owner from the first Owner, with an actionable message", async () => {
    const r = await execute(registry, adapter, systemCtx, "users.set_roles", {
      userId: firstOwnerId,
      roleNames: ["editor"],
    });
    expect(errMessage(r)).toContain('keep "owner" in roleNames');
    expect(await rolesOf(firstOwnerId)).toEqual(["owner"]);
  });

  it("users.set_roles still lets the first Owner gain roles next to owner", async () => {
    ok(
      await execute(registry, adapter, systemCtx, "users.set_roles", {
        userId: firstOwnerId,
        roleNames: ["owner", "editor"],
      }),
    );
    expect(await rolesOf(firstOwnerId)).toEqual(["editor", "owner"]);
  });

  it("any other Owner can still be demoted", async () => {
    ok(
      await execute(registry, adapter, systemCtx, "users.set_roles", {
        userId: secondOwnerId,
        roleNames: ["editor"],
      }),
    );
    expect(await rolesOf(secondOwnerId)).toEqual(["editor"]);
  });

  it("users.propose_set_roles refuses the same change before it reaches the queue", async () => {
    const r = await execute(registry, adapter, systemCtx, "users.propose_set_roles", {
      userId: firstOwnerId,
      roleNames: ["reviewer"],
    });
    expect(errMessage(r)).toContain('keep "owner" in roleNames');
  });

  it("users.execute_proposal refuses an already-queued proposal that would drop it", async () => {
    // A proposal queued before the guard existed: queue a legal one for
    // the second user, then point it at the first Owner.
    const proposed = ok<{ proposalId: string }>(
      await execute(registry, adapter, systemCtx, "users.propose_set_roles", {
        userId: secondOwnerId,
        roleNames: ["reviewer"],
      }),
    );
    await asSystem(
      (tx) => tx`
        UPDATE user_pending_actions
        SET user_id = ${firstOwnerId}::uuid,
            payload = jsonb_set(payload, '{userId}', to_jsonb(${firstOwnerId}::text))
        WHERE id = ${proposed.proposalId}::uuid`,
    );
    const r = await execute(registry, adapter, systemCtx, "users.execute_proposal", {
      proposalId: proposed.proposalId,
    });
    expect(errMessage(r)).toContain('keep "owner" in roleNames');
    expect(await rolesOf(firstOwnerId)).toEqual(["editor", "owner"]);
  });
});

describe("M-10 — the built-in owner role's permissions are fixed", () => {
  it("roles.update_permissions refuses the owner role and leaves it intact", async () => {
    const before = await permissionsOf(ownerRoleId);
    expect(before.length).toBeGreaterThan(1);
    const r = await execute(registry, adapter, systemCtx, "roles.update_permissions", {
      roleId: ownerRoleId,
      permissions: ["content.read"],
    });
    expect(errMessage(r)).toContain("Create a custom role");
    expect(await permissionsOf(ownerRoleId)).toEqual(before);
  });

  it("roles.update_permissions still edits a custom role", async () => {
    ok(
      await execute(registry, adapter, systemCtx, "roles.update_permissions", {
        roleId: customRoleId,
        permissions: ["content.read", "content.write"],
      }),
    );
    expect(await permissionsOf(customRoleId)).toEqual(["content.read", "content.write"]);
  });

  it("roles.propose_update_permissions refuses the owner role", async () => {
    const r = await execute(registry, adapter, systemCtx, "roles.propose_update_permissions", {
      roleId: ownerRoleId,
      permissions: ["content.read"],
    });
    expect(errMessage(r)).toContain("Create a custom role");
  });

  it("roles.execute_proposal refuses an already-queued owner-role change", async () => {
    const before = await permissionsOf(ownerRoleId);
    const proposed = ok<{ proposalId: string }>(
      await execute(registry, adapter, systemCtx, "roles.propose_update_permissions", {
        roleId: customRoleId,
        permissions: ["content.read"],
      }),
    );
    await asSystem(
      (tx) => tx`
        UPDATE role_pending_actions
        SET role_id = ${ownerRoleId}::uuid,
            payload = jsonb_set(payload, '{roleId}', to_jsonb(${ownerRoleId}::text))
        WHERE id = ${proposed.proposalId}::uuid`,
    );
    const r = await execute(registry, adapter, systemCtx, "roles.execute_proposal", {
      proposalId: proposed.proposalId,
    });
    expect(errMessage(r)).toContain("Create a custom role");
    expect(await permissionsOf(ownerRoleId)).toEqual(before);
  });
});

describe("M-09 — a deleted user's MCP tokens stop working", () => {
  async function userWithToken(email: string): Promise<{ userId: string; token: string }> {
    const userId = ok<{ userId: string }>(
      await execute(registry, adapter, systemCtx, "users.create", {
        email,
        password: "lantern-meadow-cobalt-93",
        displayName: email,
        roleNames: ["editor"],
      }),
    ).userId;
    const humanCtx: ExecutionContext = { actorId: userId, actorKind: "human", requestId: email };
    const minted = ok<{ plaintextToken: string }>(
      await execute(registry, adapter, humanCtx, "mcp_tokens.create", { displayName: "laptop" }),
    );
    expect((await resolveMcpToken(adapter, minted.plaintextToken)).ok).toBe(true);
    return { userId, token: minted.plaintextToken };
  }

  it("users.delete revokes the user's tokens in the same transaction and audits the count", async () => {
    const { userId, token } = await userWithToken(EMAILS.leaver);
    ok(await execute(registry, adapter, systemCtx, "users.delete", { userId }));

    const rows = (await asSystem(
      (tx) => tx`SELECT revoked_at FROM mcp_tokens WHERE actor_id = ${userId}::uuid`,
    )) as { revoked_at: Date | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked_at).not.toBeNull();
    const resolved = await resolveMcpToken(adapter, token);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toBe("revoked");

    const audit = (await asSystem(
      (tx) => tx`
        SELECT result_summary FROM audit_events
        WHERE operation = 'users.delete' AND entity_id::text = ${userId} AND succeeded`,
    )) as { result_summary: string }[];
    expect(audit.map((a) => a.result_summary)).toEqual(["soft-deleted; mcp-tokens-revoked=1"]);
  });

  it("resolveMcpToken refuses a token whose user was deleted without revoking it", async () => {
    // Rows from before users.delete revoked tokens: deleted user, live token.
    const { userId, token } = await userWithToken(EMAILS.legacy);
    await asSystem((tx) => tx`UPDATE users SET deleted_at = now() WHERE id = ${userId}::uuid`);
    const resolved = await resolveMcpToken(adapter, token);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBe("user_deleted");
    // The holder sees a live-looking token refused, so the message names the fix.
    expect(mcpTokenAuthErrorMessage(resolved.error)).toMatch(
      /^auth_error: token user_deleted — .*\/settings\/mcp/,
    );
  });
});
