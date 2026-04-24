// SPDX-License-Identifier: MPL-2.0

/**
 * Custom-role CRUD + built-in protection.
 *
 * bun test runs files in parallel, so all deletes are scoped to this file's
 * own fixtures (role name `translator_test`, no user rows touched).
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
  actorId: "00000000-0000-0000-0000-0000000000bb",
  actorKind: "system",
  requestId: "roles-test",
};

const CUSTOM_ROLE_NAME = "translator_test";

async function wipeCustomRole(url: string): Promise<void> {
  const sql = new SQL(url);
  try {
    await sql`DELETE FROM roles WHERE name = ${CUSTOM_ROLE_NAME} AND is_builtin = false`;
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipeCustomRole(ADMIN_URL);
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipeCustomRole(ADMIN_URL);
  await adapter.close();
});

describe("roles CRUD", () => {
  it("lists the three built-ins out of the box", async () => {
    const res = await execute(registry, adapter, systemCtx, "roles.list", {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const names = (res.value as { roles: { name: string; isBuiltin: boolean }[] }).roles
      .filter((r) => r.isBuiltin)
      .map((r) => r.name)
      .sort();
    expect(names).toEqual(["editor", "owner", "reviewer"]);
  });

  it("creates a custom role with a reduced permission set", async () => {
    const res = await execute(registry, adapter, systemCtx, "roles.create", {
      name: CUSTOM_ROLE_NAME,
      description: "Translations + content read only",
      permissions: ["content.read", "translations.write"],
    });
    expect(res.ok).toBe(true);

    const list = await execute(registry, adapter, systemCtx, "roles.list", {});
    if (!list.ok) throw new Error("list failed");
    const custom = (
      list.value as {
        roles: { name: string; isBuiltin: boolean; permissions: string[] }[];
      }
    ).roles.find((r) => r.name === CUSTOM_ROLE_NAME);
    expect(custom).toBeTruthy();
    expect(custom?.isBuiltin).toBe(false);
    expect(custom?.permissions.sort()).toEqual(["content.read", "translations.write"]);
  });

  it("rejects creating a role that reuses a built-in name", async () => {
    const res = await execute(registry, adapter, systemCtx, "roles.create", {
      name: "owner",
      description: "",
      permissions: [],
    });
    expect(res.ok).toBe(false);
  });

  it("rejects deleting a built-in role", async () => {
    const list = await execute(registry, adapter, systemCtx, "roles.list", {});
    if (!list.ok) throw new Error("list failed");
    const owner = (list.value as { roles: { id: string; name: string }[] }).roles.find(
      (r) => r.name === "owner",
    );
    expect(owner).toBeTruthy();
    const res = await execute(registry, adapter, systemCtx, "roles.delete", {
      roleId: owner?.id ?? "",
    });
    expect(res.ok).toBe(false);
  });

  it("updates permissions on an existing custom role", async () => {
    const list1 = await execute(registry, adapter, systemCtx, "roles.list", {});
    if (!list1.ok) throw new Error("list failed");
    const custom = (list1.value as { roles: { id: string; name: string }[] }).roles.find(
      (r) => r.name === CUSTOM_ROLE_NAME,
    );
    expect(custom).toBeTruthy();

    const res = await execute(registry, adapter, systemCtx, "roles.update_permissions", {
      roleId: custom?.id ?? "",
      permissions: ["content.read"],
    });
    expect(res.ok).toBe(true);

    const list2 = await execute(registry, adapter, systemCtx, "roles.list", {});
    if (!list2.ok) throw new Error("list2 failed");
    const updated = (
      list2.value as {
        roles: { name: string; permissions: string[] }[];
      }
    ).roles.find((r) => r.name === CUSTOM_ROLE_NAME);
    expect(updated?.permissions).toEqual(["content.read"]);
  });

  it("deletes a custom role", async () => {
    const list1 = await execute(registry, adapter, systemCtx, "roles.list", {});
    if (!list1.ok) throw new Error("list failed");
    const custom = (list1.value as { roles: { id: string; name: string }[] }).roles.find(
      (r) => r.name === CUSTOM_ROLE_NAME,
    );
    expect(custom).toBeTruthy();
    const res = await execute(registry, adapter, systemCtx, "roles.delete", {
      roleId: custom?.id ?? "",
    });
    expect(res.ok).toBe(true);

    const list2 = await execute(registry, adapter, systemCtx, "roles.list", {});
    if (!list2.ok) throw new Error("list2 failed");
    expect(
      (list2.value as { roles: { name: string }[] }).roles.some((r) => r.name === CUSTOM_ROLE_NAME),
    ).toBe(false);
  });
});
