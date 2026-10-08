// SPDX-License-Identifier: MPL-2.0

/**
 * #589 + #588 against a real Postgres.
 *
 * #589 — any human who can open a chat sees a gated tool's Approve card, so
 * every §11.A executor checks the APPROVER's permission through their roles:
 *  - every gated tool's executor refuses a reviewer (content.read) and an
 *    editor (content.write) unless their role carries the declared
 *    permission, and lets an Owner past the gate;
 *  - the privilege-escalation case end to end on the chat path
 *    (`attachGatedExecute`): a reviewer approving `propose_update_role_permissions`
 *    changes nothing and leaves the proposal pending for an Owner;
 *  - deploy promote / rollback and site revert rows stay pending when an
 *    editor or reviewer approves.
 *
 * #588 — `email_config.get` never hands transport secrets to the AI.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

import type { FilteredTool } from "../ai/chat-runner/tool-catalogue.js";
import { attachGatedExecute } from "../ai/tools/gated-tools.js";
import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { approverPermissionsOf } from "../ops/_approver-permission.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "gated-approver-permission",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "gated-approver-permission-ai",
};
const RUN = crypto.randomUUID().slice(0, 8);

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
const users: Record<"owner" | "editor" | "reviewer", ExecutionContext> = {} as never;
const held: Record<"owner" | "editor" | "reviewer", Set<string>> = {} as never;

async function asSystem<T>(
  fn: (tx: Parameters<Parameters<DatabaseAdapter["withAdminTransaction"]>[1]>[0]) => Promise<T>,
): Promise<T> {
  return adapter.withAdminTransaction(SYSTEM, fn);
}

async function makeUser(role: "owner" | "editor" | "reviewer"): Promise<ExecutionContext> {
  const id = crypto.randomUUID();
  await asSystem(async (tx) => {
    await tx.execute(
      sql`INSERT INTO actors (id, kind, display_name) VALUES (${id}::uuid, 'human', ${`approver-${role}-${RUN}`})`,
    );
    await tx.execute(
      sql`INSERT INTO users (id, email, password_hash) VALUES (${id}::uuid, ${`${id}@approver.test`}, 'test-only')`,
    );
    await tx.execute(
      sql`INSERT INTO user_roles (user_id, role_id) SELECT ${id}::uuid, id FROM roles WHERE name = ${role}`,
    );
  });
  return { actorId: id, actorKind: "human", requestId: `gated-approver-${role}` };
}

async function permissionsOfRole(role: string): Promise<Set<string>> {
  const rows = (await asSystem((tx) =>
    tx.execute(sql`
      SELECT p.name FROM roles r
      JOIN role_permissions rp ON rp.role_id = r.id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE r.name = ${role}`),
  )) as unknown as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function message(r: { ok: boolean }): string {
  return r.ok ? "" : JSON.stringify((r as { error: unknown }).error);
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  for (const role of ["owner", "editor", "reviewer"] as const) {
    users[role] = await makeUser(role);
    held[role] = await permissionsOfRole(role);
  }
});

afterAll(async () => {
  await adapter.close();
});

/** Every executor a gated chat tool applies through. */
const gatedExecutors = [
  ...new Set(
    createDefaultToolRegistry()
      .list()
      .flatMap((t) => (t.gated ? [t.gated.executeOp] : [])),
  ),
].sort();

describe("#589 — every gated executor checks the approver's permission", () => {
  it("covers the gated domains", () => {
    expect(gatedExecutors).toContain("roles.execute_proposal");
    expect(gatedExecutors).toContain("deploy.execute_proposal");
    expect(gatedExecutors).toContain("snapshots.execute_proposal");
    expect(gatedExecutors).toContain("plugins.execute_activation");
    expect(gatedExecutors).toContain("owner_settings.execute_proposal");
    expect(gatedExecutors).toContain("site_defaults.execute_proposal");
  });

  for (const op of gatedExecutors) {
    it(`${op}: reviewer/editor refused unless their role holds it; Owner passes the gate`, async () => {
      const lookup = registry.lookup(op);
      if (!lookup.ok) throw new Error(`${op} not registered`);
      const required = approverPermissionsOf(lookup.value) ?? [];
      expect(required.length).toBeGreaterThan(0);
      // An unknown proposal: the gate answers before the row lookup, so a
      // refusal here proves no approver without the permission reaches it.
      const input = { proposalId: crypto.randomUUID() };
      for (const role of ["reviewer", "editor", "owner"] as const) {
        const r = await execute(registry, adapter, users[role], op, input);
        expect(r.ok).toBe(false);
        const text = message(r);
        const allowed = required.every((p) => held[role].has(p));
        if (allowed) {
          expect(text).not.toContain("permission_denied");
        } else {
          expect(text).toContain("permission_denied");
          for (const p of required.filter((p) => !held[role].has(p))) expect(text).toContain(p);
        }
      }
    });
  }
});

describe("#589 — chat path: a reviewer cannot approve a role-permission change", () => {
  it("refuses, changes nothing, and leaves the proposal pending for an Owner", async () => {
    const created = await execute(registry, adapter, SYSTEM, "roles.create", {
      name: `approver-test-${RUN}`,
      permissions: ["content.read"],
    });
    if (!created.ok) throw new Error(message(created));
    const roleId = (created.value as { roleId: string }).roleId;

    const tool = createDefaultToolRegistry()
      .catalogue()
      .find((t) => t.gated?.proposeOp === "roles.propose_update_permissions");
    if (!tool) throw new Error("no gated tool for roles.propose_update_permissions");
    const approvedBy = (approver: ExecutionContext) =>
      attachGatedExecute(tool as FilteredTool, registry, adapter, AI, approver).execute?.({
        roleId,
        permissions: ["content.read", "roles.manage", "users.manage"],
      }) as Promise<{ ok: boolean; error?: string }>;

    const refused = await approvedBy(users.reviewer);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("roles.manage");
    expect(refused.error).toContain("/security/roles/pending");
    const rolePerms = async () =>
      (
        (await asSystem((tx) =>
          tx.execute(sql`
            SELECT p.name FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
            WHERE rp.role_id = ${roleId}::uuid ORDER BY p.name`),
        )) as unknown as { name: string }[]
      ).map((r) => r.name);
    expect(await rolePerms()).toEqual(["content.read"]);
    const pending = (await asSystem((tx) =>
      tx.execute(sql`
        SELECT id::text AS id, status FROM role_pending_actions
        WHERE role_id = ${roleId}::uuid AND kind = 'update_permissions'`),
    )) as unknown as { id: string; status: string }[];
    expect(pending.map((p) => p.status)).toEqual(["pending"]);

    // The Owner approves the SAME proposal from the queue.
    const applied = await execute(registry, adapter, users.owner, "roles.execute_proposal", {
      proposalId: pending[0]?.id,
    });
    expect(message(applied)).toBe("");
    expect(await rolePerms()).toEqual(["content.read", "roles.manage", "users.manage"]);
  });
});

describe("#589 — deploy promote/rollback and site revert stay pending on a refused approve", () => {
  for (const kind of ["promote", "rollback"] as const) {
    it(`deploy ${kind}`, async () => {
      const rows = (await asSystem((tx) =>
        tx.execute(sql`
          INSERT INTO deploy_pending_actions (kind, proposed_by, payload, preview, status, payload_hash)
          VALUES (${kind}, ${AI.actorId}::uuid, '{}'::jsonb, '{}'::jsonb, 'pending', ${`approver-${kind}-${RUN}`})
          RETURNING id::text AS id`),
      )) as unknown as { id: string }[];
      const proposalId = rows[0]?.id;
      for (const role of ["reviewer", "editor"] as const) {
        const r = await execute(registry, adapter, users[role], "deploy.execute_proposal", {
          proposalId,
        });
        expect(message(r)).toContain("deploy.trigger");
      }
      const status = (await asSystem((tx) =>
        tx.execute(sql`SELECT status FROM deploy_pending_actions WHERE id = ${proposalId}::uuid`),
      )) as unknown as { status: string }[];
      expect(status[0]?.status).toBe("pending");
      await asSystem((tx) =>
        tx.execute(sql`DELETE FROM deploy_pending_actions WHERE id = ${proposalId}::uuid`),
      );
    });
  }

  it("snapshots revert_site needs roles.manage", async () => {
    for (const role of ["reviewer", "editor"] as const) {
      const r = await execute(registry, adapter, users[role], "snapshots.execute_proposal", {
        proposalId: crypto.randomUUID(),
      });
      expect(message(r)).toContain("roles.manage");
    }
  });
});

describe("#588 — email_config.get never returns transport secrets to the AI", () => {
  it("redacts for the AI, keeps the values for the Owner panel and the system", async () => {
    const before = await execute(registry, adapter, SYSTEM, "email_config.get", {});
    if (!before.ok) throw new Error(message(before));
    const saved = (
      before.value as {
        config: { transport: string; fromAddress: string; config: Record<string, unknown> };
      }
    ).config;
    const set = await execute(registry, adapter, SYSTEM, "email_config.set", {
      transport: "resend",
      fromAddress: "noreply@approver.test",
      config: { apiKey: "re_live_secret_value_123" },
    });
    expect(message(set)).toBe("");
    try {
      const byAi = await execute(registry, adapter, AI, "email_config.get", {});
      expect(byAi.ok).toBe(true);
      const aiText = JSON.stringify(byAi);
      expect(aiText).not.toContain("re_live_secret_value_123");
      expect(
        (byAi as { value: { config: { config: Record<string, unknown> } } }).value.config.config
          .apiKey,
      ).toBe("[redacted]");

      const byOwner = await execute(registry, adapter, users.owner, "email_config.get", {});
      expect(JSON.stringify(byOwner)).toContain("re_live_secret_value_123");
    } finally {
      await execute(registry, adapter, SYSTEM, "email_config.set", {
        transport: saved.transport,
        fromAddress: saved.fromAddress,
        config: saved.config,
      });
    }
  });
});
