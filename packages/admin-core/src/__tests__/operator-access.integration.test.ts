// SPDX-License-Identifier: MPL-2.0

/**
 * Operator access on Google IAP installs, against real Postgres (§6):
 *
 *   - the sync job's database read path: `users.operator_access_members`
 *     returns exactly the emails that should pass IAP, and the
 *     `operator_access_reader` role it runs as can read those columns and
 *     nothing else — no password hashes, no writes (migration 0239);
 *   - the admin side: an Owner-approved user or role change starts the job
 *     (a recording fake trigger here), the outcome lands on the tool result
 *     and in the audit log, and a failure is loud.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import type { FilteredTool } from "../ai/chat-runner/tool-catalogue.js";
import { attachGatedExecute } from "../ai/tools/gated-tools.js";
import {
  proposeRoleDeleteTool,
  proposeUserCreateTool,
  proposeUserDeleteTool,
  proposeUserSetRolesTool,
} from "../ai/tools/propose-tools-batch.js";
import {
  type OperatorAccessSync,
  operatorAccessMembersOp,
  setOperatorAccessTriggerForTests,
  syncOperatorAccess,
} from "../ops/user_access.js";
import { registerAdminOps } from "../register.js";
import {
  OperatorAccessError,
  type OperatorAccessTrigger,
} from "../security/operator-access/gcp-job-trigger.js";

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
  "opaccess-editor@example.com",
  "opaccess-noroles@example.com",
  "opaccess-chat@example.com",
  "opaccess-gone@example.com",
  "opaccess-customrole@example.com",
] as const;
const CUSTOM_ROLE = "opaccess-temp-role";

/** Records every start; optionally fails or ends the run like Google would. */
function fakeTrigger(opts: { fail?: OperatorAccessError; state?: "succeeded" | "failed" } = {}) {
  let starts = 0;
  const trigger: OperatorAccessTrigger = {
    label: "Google IAP (fake job)",
    async start() {
      if (opts.fail) throw opts.fail;
      starts += 1;
      return `exec-${starts}`;
    },
    async wait(execution) {
      return { execution, state: opts.state ?? "succeeded", logsUrl: `https://logs/${execution}` };
    },
    async latest() {
      return null;
    },
  };
  return { trigger, starts: () => starts };
}

async function admin<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const db = new SQL(ADMIN_URL as string);
  try {
    let result!: T;
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      result = await fn(tx as unknown as SQL);
    });
    return result;
  } finally {
    await db.end();
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

async function lastAudit(actorId: string): Promise<{ succeeded: boolean; summary: string }> {
  const rows = await admin(
    (tx) =>
      tx`SELECT succeeded, result_summary AS summary FROM audit_events
         WHERE operation = 'users.record_operator_access_sync' AND actor_id = ${actorId}::uuid
         ORDER BY created_at DESC LIMIT 1` as Promise<{ succeeded: boolean; summary: string }[]>,
  );
  const row = rows[0];
  if (!row) throw new Error("no audit row");
  return row;
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
  await createUser(EMAILS[1], ["editor"]);
  await createUser(EMAILS[2], []);
  const gone = await createUser(EMAILS[4], ["editor"]);
  const del = await execute(registry, adapter, SYSTEM, "users.delete", { userId: gone });
  if (!del.ok) throw new Error(JSON.stringify(del.error));
});

afterEach(() => setOperatorAccessTriggerForTests(null));

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("sync job read path — users.operator_access_members", () => {
  const ours = (emails: string[]) => emails.filter((e) => EMAILS.some((x) => x === e));

  it("lists exactly the non-deleted users that hold a role", async () => {
    const r = await execute(registry, adapter, SYSTEM, "users.operator_access_members", {});
    expect(r.ok).toBe(true);
    const emails = r.ok ? (r.value as { emails: string[] }).emails : [];
    expect(ours(emails)).toEqual([EMAILS[1], OWNER_EMAIL].sort());
  });

  it("works as the read-only operator_access_reader role, which can read nothing else and write nothing", async () => {
    const result = await adapter.withAdminTransaction(SYSTEM, async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE operator_access_reader`);
      // RLS must not depend on the session's actor kind for this role.
      await tx.execute(sql`SELECT set_config('caelo.actor_kind', '', true)`);
      return operatorAccessMembersOp.handler(SYSTEM, {}, tx);
    });
    expect(result.ok).toBe(true);
    expect(ours(result.ok ? result.value.emails : [])).toEqual([EMAILS[1], OWNER_EMAIL].sort());

    for (const forbidden of [
      "SELECT password_hash FROM users LIMIT 1",
      "SELECT user_id FROM sessions LIMIT 1",
      "UPDATE users SET deleted_at = now() WHERE false",
      "INSERT INTO user_roles (user_id, role_id) SELECT id, id FROM users WHERE false",
      "SELECT id FROM roles LIMIT 1",
    ]) {
      const denied = await adapter
        .withAdminTransaction(SYSTEM, async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE operator_access_reader`);
          await tx.execute(sql.raw(forbidden));
          return "allowed";
        })
        .catch((e: unknown) => String((e as { cause?: unknown }).cause ?? e));
      expect(denied).toContain("permission denied");
    }
  });

  it("is not reachable by humans or the AI", async () => {
    for (const ctx of [OWNER, AI]) {
      const r = await execute(registry, adapter, ctx, "users.operator_access_members", {});
      expect(r.ok === false && r.error.kind).toBe("ActorScopeRejected");
    }
  });
});

describe("syncOperatorAccess — the admin starts the job and records the outcome", () => {
  it("is not-applicable without IAP (self-hosted), and audited as such", async () => {
    setOperatorAccessTriggerForTests({ trigger: null });
    const r = await syncOperatorAccess(registry, adapter, OWNER);
    expect(r.status).toBe("not-applicable");
    expect(await lastAudit(OWNER.actorId)).toEqual({ succeeded: true, summary: "not-applicable" });
  });

  it("a finished run is synced; a failed run is failed with the log link, audited as failed", async () => {
    setOperatorAccessTriggerForTests({ trigger: fakeTrigger().trigger });
    expect(await syncOperatorAccess(registry, adapter, OWNER)).toEqual({
      status: "synced",
      target: "Google IAP (fake job)",
      execution: "exec-1",
      logsUrl: "https://logs/exec-1",
    });

    setOperatorAccessTriggerForTests({ trigger: fakeTrigger({ state: "failed" }).trigger });
    const failed = await syncOperatorAccess(registry, adapter, OWNER);
    expect(failed.status).toBe("failed");
    expect(failed.status === "failed" && failed.error).toContain("https://logs/exec-1");
    expect((await lastAudit(OWNER.actorId)).succeeded).toBe(false);
  });

  it("a job the admin cannot start is a loud failure with the next step", async () => {
    setOperatorAccessTriggerForTests({
      trigger: fakeTrigger({
        fail: new OperatorAccessError("run.jobs.run denied", "Run `cms-provision upgrade`."),
      }).trigger,
    });
    const r = await syncOperatorAccess(registry, adapter, OWNER);
    expect(r).toEqual({
      status: "failed",
      target: "Google IAP (fake job)",
      error: "run.jobs.run denied",
      nextStep: "Run `cms-provision upgrade`.",
    });
  });

  it("the AI cannot record a sync outcome itself", async () => {
    const r = await execute(registry, adapter, AI, "users.record_operator_access_sync", {
      status: "not-applicable",
      reason: "x",
    });
    expect(r.ok === false && r.error.kind).toBe("ActorScopeRejected");
  });

  it("the AI can list other users (users RLS no longer hides them), so it can target one", async () => {
    const r = await execute(registry, adapter, AI, "users.list", {});
    const emails = r.ok
      ? (r.value as { users: { email: string }[] }).users.map((u) => u.email)
      : [];
    expect(emails).toContain(OWNER_EMAIL);
  });
});

describe("gated tools — afterApply sync-operator-access", () => {
  const gatedTool = (
    tool: typeof proposeUserCreateTool | typeof proposeRoleDeleteTool,
  ): FilteredTool =>
    ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      gated: tool.gated,
    }) as FilteredTool;

  it("declares the post-commit sync on user create, set-roles, delete and role delete", () => {
    for (const tool of [
      proposeUserCreateTool,
      proposeUserSetRolesTool,
      proposeUserDeleteTool,
      proposeRoleDeleteTool,
    ]) {
      expect(tool.gated?.afterApply).toBe("sync-operator-access");
    }
  });

  it("an approved create and delete each start the job, attributed to the approving Owner", async () => {
    const fake = fakeTrigger();
    setOperatorAccessTriggerForTests({ trigger: fake.trigger });
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
    expect(created.value.note).toContain("up to date");

    const del = attachGatedExecute(gatedTool(proposeUserDeleteTool), registry, adapter, AI, OWNER);
    const deleted = (await del.execute?.({ userId: created.value.userId as string })) as {
      ok: boolean;
    };
    expect(deleted).toMatchObject({ ok: true });
    expect(fake.starts()).toBe(2);
    expect((await lastAudit(OWNER.actorId)).summary).toBe("synced: exec-2");
  });

  it("an approved role deletion starts the job (it can strip someone's last role)", async () => {
    const created = await execute(registry, adapter, SYSTEM, "roles.create", {
      name: CUSTOM_ROLE,
      description: "temporary",
      permissions: [],
    });
    expect(created.ok).toBe(true);
    const roleId = created.ok ? (created.value as { roleId: string }).roleId : "";
    await createUser(EMAILS[5], [CUSTOM_ROLE]);
    const fake = fakeTrigger();
    setOperatorAccessTriggerForTests({ trigger: fake.trigger });
    const del = attachGatedExecute(gatedTool(proposeRoleDeleteTool), registry, adapter, AI, OWNER);
    const r = (await del.execute?.({ roleId })) as { ok: boolean; value: Record<string, unknown> };
    expect(r).toMatchObject({ ok: true, value: { kind: "delete" } });
    expect(fake.starts()).toBe(1);
    // The user who lost their only role is no longer in the job's input.
    const members = await execute(registry, adapter, SYSTEM, "users.operator_access_members", {});
    expect(members.ok && (members.value as { emails: string[] }).emails).not.toContain(EMAILS[5]);
  });

  it("a failed sync keeps the applied change but carries a warning the AI must relay", async () => {
    setOperatorAccessTriggerForTests({
      trigger: fakeTrigger({
        fail: new OperatorAccessError("run.jobs.run denied", "Run `cms-provision upgrade`."),
      }).trigger,
    });
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
