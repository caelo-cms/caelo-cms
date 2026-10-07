// SPDX-License-Identifier: MPL-2.0

/**
 * `users.sync_operator_access` + the gated user tools' `afterApply`: an
 * Owner-approved user change brings the cloud identity gate (Google IAP) in
 * line, and a failed sync is loud on the approval result. Real Postgres
 * (§6); the Google side is a recording fake backend.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { FilteredTool } from "../ai/chat-runner/tool-catalogue.js";
import { attachGatedExecute } from "../ai/tools/gated-tools.js";
import {
  proposeRoleDeleteTool,
  proposeUserCreateTool,
  proposeUserDeleteTool,
  proposeUserSetRolesTool,
} from "../ai/tools/propose-tools-batch.js";
import { type OperatorAccessSync, setOperatorAccessBackendForTests } from "../ops/user_access.js";
import { registerAdminOps } from "../register.js";
import {
  type OperatorAccessBackend,
  OperatorAccessError,
} from "../security/operator-access/gcp-iap.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000a11a0",
  actorKind: "ai",
  requestId: "operator-access-ai",
};
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "operator-access-sys",
};
let OWNER: ExecutionContext;

const OWNER_EMAIL = "opaccess-owner@example.com";
const EMAILS = [
  OWNER_EMAIL,
  "opaccess-new@example.com",
  "opaccess-noroles@example.com",
  "opaccess-chat@example.com",
  "opaccess-gone@example.com",
  "opaccess-customrole@example.com",
] as const;
const CUSTOM_ROLE = "opaccess-temp-role";

/** Records every grant/revoke; optionally fails like Google would. */
function recordingBackend(failWith?: OperatorAccessError) {
  const calls: { principal: string; allow: boolean }[] = [];
  const backend: OperatorAccessBackend = {
    label: "Google IAP (fake)",
    async setAccess(principal, allow) {
      if (failWith) throw failWith;
      calls.push({ principal, allow });
    },
  };
  return { backend, calls };
}

async function admin<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    let result!: T;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      result = await fn(tx as unknown as SQL);
    });
    return result;
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await admin(async (tx) => {
    for (const email of EMAILS) {
      await tx`DELETE FROM user_pending_actions WHERE payload::text LIKE ${`%${email}%`}`;
      await tx`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
      await tx`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
      await tx`DELETE FROM users WHERE email = ${email}`;
    }
    await tx`DELETE FROM role_pending_actions WHERE proposed_by = ${AI.actorId}::uuid`;
    await tx`DELETE FROM roles WHERE name = ${CUSTOM_ROLE}`;
  });
}

async function createUser(email: string, roleNames: string[]): Promise<string> {
  const r = await execute(registry, adapter, SYSTEM, "users.create", {
    email,
    password: "harbor-lantern-quill-71",
    displayName: email.split("@")[0],
    roleNames,
  });
  if (!r.ok) throw new Error(`seed ${email}: ${JSON.stringify(r.error)}`);
  return (r.value as { userId: string }).userId;
}

async function sync(userId: string, ctx: ExecutionContext = SYSTEM) {
  return execute(registry, adapter, ctx, "users.sync_operator_access", { userIds: [userId] });
}

beforeAll(async () => {
  await admin(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${AI.actorId}::uuid, 'ai', 'opaccess-ai') ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${SYSTEM.actorId}::uuid, 'system', 'opaccess-system') ON CONFLICT DO NOTHING`;
  });
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  const ownerId = await createUser(OWNER_EMAIL, ["owner"]);
  OWNER = { actorId: ownerId, actorKind: "human", requestId: "operator-access-owner" };
});

afterEach(() => setOperatorAccessBackendForTests(null));

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("users.sync_operator_access", () => {
  it("is not-applicable without IAP (self-hosted) and changes nothing", async () => {
    setOperatorAccessBackendForTests({ backend: null });
    const userId = await createUser(EMAILS[1], ["editor"]);
    const r = await sync(userId);
    expect(r.ok && (r.value as OperatorAccessSync).status).toBe("not-applicable");
  });

  it("grants a user with a role, revokes one without, and audits it", async () => {
    const { backend, calls } = recordingBackend();
    setOperatorAccessBackendForTests({ backend });
    const withRole = await admin(
      (tx) =>
        tx`SELECT id::text AS id FROM users WHERE email = ${EMAILS[1]}` as Promise<
          { id: string }[]
        >,
    );
    const noRoles = await createUser(EMAILS[2], []);

    const granted = await sync(withRole[0]?.id as string);
    expect(granted.ok && granted.value).toEqual({
      status: "synced",
      target: "Google IAP (fake)",
      changes: [{ principal: `user:${EMAILS[1]}`, access: "granted" }],
    });
    const revoked = await sync(noRoles);
    expect(revoked.ok && (revoked.value as OperatorAccessSync).status).toBe("synced");
    expect(calls).toEqual([
      { principal: `user:${EMAILS[1]}`, allow: true },
      { principal: `user:${EMAILS[2]}`, allow: false },
    ]);
    const audit = await admin(
      (tx) =>
        tx`SELECT succeeded FROM audit_events WHERE operation = 'users.sync_operator_access' AND entity_id IS NULL ORDER BY created_at DESC LIMIT 1` as Promise<
          { succeeded: boolean }[]
        >,
    );
    expect(audit[0]?.succeeded).toBe(true);
  });

  it("reports a Google failure as status failed with the next step, audited as failed", async () => {
    const { backend } = recordingBackend(
      new OperatorAccessError(
        "update the admin's IAP allowlist: HTTP 403",
        "Run `cms-provision upgrade`.",
      ),
    );
    setOperatorAccessBackendForTests({ backend });
    const ids = await admin(
      (tx) =>
        tx`SELECT id::text AS id FROM users WHERE email = ${EMAILS[1]}` as Promise<
          { id: string }[]
        >,
    );
    const r = await sync(ids[0]?.id as string);
    expect(r.ok && r.value).toEqual({
      status: "failed",
      target: "Google IAP (fake)",
      changes: [],
      error: "update the admin's IAP allowlist: HTTP 403",
      nextStep: "Run `cms-provision upgrade`.",
    });
    const audit = await admin(
      (tx) =>
        tx`SELECT succeeded FROM audit_events WHERE operation = 'users.sync_operator_access' ORDER BY created_at DESC LIMIT 1` as Promise<
          { succeeded: boolean }[]
        >,
    );
    expect(audit[0]?.succeeded).toBe(false);
  });

  it("refuses loudly when the user is invisible (human ctx under users RLS) instead of syncing nothing", async () => {
    setOperatorAccessBackendForTests(recordingBackend());
    const ids = await admin(
      (tx) =>
        tx`SELECT id::text AS id FROM users WHERE email = ${EMAILS[1]}` as Promise<
          { id: string }[]
        >,
    );
    const r = await sync(ids[0]?.id as string, OWNER);
    expect(r.ok).toBe(false);
  });

  it("allUsers recomputes every user on the list, deleted ones included (the retry path)", async () => {
    const goneId = await createUser(EMAILS[4], ["editor"]);
    const del = await execute(registry, adapter, SYSTEM, "users.delete", { userId: goneId });
    expect(del.ok).toBe(true);
    const { backend, calls } = recordingBackend();
    setOperatorAccessBackendForTests({ backend });
    const r = await execute(registry, adapter, SYSTEM, "users.sync_operator_access", {
      allUsers: true,
    });
    expect(r.ok && (r.value as OperatorAccessSync).status).toBe("synced");
    const ours = calls.filter((c) => EMAILS.some((e) => c.principal === `user:${e}`));
    expect(ours).toContainEqual({ principal: `user:${OWNER_EMAIL}`, allow: true });
    expect(ours).toContainEqual({ principal: `user:${EMAILS[1]}`, allow: true });
    expect(ours).toContainEqual({ principal: `user:${EMAILS[4]}`, allow: false });
    // Only emails on the user list are touched — never anything else on IAP.
    expect(calls.every((c) => c.principal.startsWith("user:"))).toBe(true);
  });

  it("allUsers refuses a human ctx (RLS would show only the caller) instead of syncing one row", async () => {
    setOperatorAccessBackendForTests(recordingBackend());
    const r = await execute(registry, adapter, OWNER, "users.sync_operator_access", {
      allUsers: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).toContain("system ctx");
  });

  it("is not reachable by the AI directly", async () => {
    const r = await execute(registry, adapter, AI, "users.sync_operator_access", {
      userIds: [OWNER.actorId],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("ActorScopeRejected");
  });
});

describe("gated user tools — afterApply sync-operator-access", () => {
  const gatedTool = (
    tool: typeof proposeUserCreateTool | typeof proposeRoleDeleteTool,
  ): FilteredTool =>
    ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      gated: tool.gated,
    }) as FilteredTool;

  it("the AI can list other users (users RLS no longer hides them), so it can target one", async () => {
    const r = await execute(registry, adapter, AI, "users.list", {});
    expect(r.ok).toBe(true);
    const emails = r.ok
      ? (r.value as { users: { email: string }[] }).users.map((u) => u.email)
      : [];
    expect(emails).toContain(OWNER_EMAIL);
  });

  it("declares the post-commit sync on create, set-roles and delete", () => {
    for (const tool of [proposeUserCreateTool, proposeUserSetRolesTool, proposeUserDeleteTool]) {
      expect(tool.gated?.afterApply).toBe("sync-operator-access");
    }
  });

  it("an approved create allows the new user on IAP; an approved delete removes them", async () => {
    const { backend, calls } = recordingBackend();
    setOperatorAccessBackendForTests({ backend });
    const create = attachGatedExecute(
      gatedTool(proposeUserCreateTool),
      registry,
      adapter,
      AI,
      OWNER,
    );
    const created = (await create.execute?.({
      email: EMAILS[3],
      displayName: "Chat Invitee",
      roleNames: ["editor"],
    })) as { ok: boolean; value: Record<string, unknown> };
    expect(created).toMatchObject({ ok: true });
    expect((created.value.operatorAccess as OperatorAccessSync).status).toBe("synced");
    expect(created.value.note).toContain(`allowed ${EMAILS[3]}`);
    expect(calls).toEqual([{ principal: `user:${EMAILS[3]}`, allow: true }]);

    const userId = created.value.userId as string;
    const del = attachGatedExecute(gatedTool(proposeUserDeleteTool), registry, adapter, AI, OWNER);
    const deleted = (await del.execute?.({ userId })) as {
      ok: boolean;
      value: Record<string, unknown>;
    };
    expect(deleted).toMatchObject({ ok: true });
    expect(calls.at(-1)).toEqual({ principal: `user:${EMAILS[3]}`, allow: false });
  });

  it("an approved role deletion revokes IAP for anyone it left without a role", async () => {
    const created = await execute(registry, adapter, SYSTEM, "roles.create", {
      name: CUSTOM_ROLE,
      description: "temporary",
      permissions: [],
    });
    expect(created.ok).toBe(true);
    const roleId = created.ok ? (created.value as { roleId: string }).roleId : "";
    await createUser(EMAILS[5], [CUSTOM_ROLE]);
    const { backend, calls } = recordingBackend();
    setOperatorAccessBackendForTests({ backend });
    expect(proposeRoleDeleteTool.gated?.afterApply).toBe("sync-operator-access");
    const del = attachGatedExecute(gatedTool(proposeRoleDeleteTool), registry, adapter, AI, OWNER);
    const r = (await del.execute?.({ roleId })) as { ok: boolean; value: Record<string, unknown> };
    expect(r).toMatchObject({ ok: true, value: { kind: "delete" } });
    expect((r.value.operatorAccess as OperatorAccessSync).status).toBe("synced");
    expect(calls).toContainEqual({ principal: `user:${EMAILS[5]}`, allow: false });
    expect(calls).toContainEqual({ principal: `user:${OWNER_EMAIL}`, allow: true });
  });

  it("a failed sync keeps the applied change but carries a warning the AI must relay", async () => {
    setOperatorAccessBackendForTests(
      recordingBackend(
        new OperatorAccessError("permission denied", "Run `cms-provision upgrade`."),
      ),
    );
    const ids = await admin(
      (tx) =>
        tx`SELECT id::text AS id FROM users WHERE email = ${EMAILS[2]}` as Promise<
          { id: string }[]
        >,
    );
    const setRoles = attachGatedExecute(
      gatedTool(proposeUserSetRolesTool),
      registry,
      adapter,
      AI,
      OWNER,
    );
    const r = (await setRoles.execute?.({
      userId: ids[0]?.id,
      roleNames: ["editor"],
    })) as { ok: boolean; value: Record<string, unknown> };
    expect(r.ok).toBe(true);
    expect((r.value.operatorAccess as OperatorAccessSync).status).toBe("failed");
    expect(r.value.warning).toContain("could NOT be updated");
    expect(r.value.warning).toContain("cms-provision upgrade");
    const roles = await admin(
      (tx) =>
        tx`SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ${ids[0]?.id}::uuid` as Promise<
          { name: string }[]
        >,
    );
    expect(roles.map((x) => x.name)).toEqual(["editor"]);
  });
});
