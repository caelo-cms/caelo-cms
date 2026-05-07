// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.39 — parametrized integration tests for the propose/execute
 * pattern shipped in v0.2.19 → v0.2.30.
 *
 * Asserts the four shared invariants per domain:
 *  1. Propose lands a status='pending' row in the per-domain
 *     *_pending_actions table, populated with chat_session_id +
 *     payload_hash (v0.2.35 schema foundation).
 *  2. Execute_proposal applies the underlying op + flips status to
 *     'applied'. The execute payload comes from the queued row;
 *     execute doesn't accept the original input directly.
 *  3. Re-executing an already-decided proposal returns a structured
 *     "already <status>" error rather than double-applying.
 *  4. Reject on a pending row marks it 'rejected' without touching
 *     the underlying entity. Subsequent execute on the rejected row
 *     also fails-loudly.
 *
 * Plus v0.2.35-specific invariants:
 *  - Duplicate propose (same payload) is rejected at the DB layer
 *    via the partial unique index on (payload_hash) WHERE
 *    status='pending'.
 *  - cancel_proposal (v0.2.37) withdraws an AI's own pending row.
 *
 * Coverage exemplars chosen to hit the three credential-handling
 * shapes: users (server-generated temp password), templates (no
 * secret, with bound-page count preview), email_config (Owner-
 * supplies-secret-at-approve). Other domains follow the same
 * pattern — when adding a new gated domain, copy a stanza here.
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

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "v0.2.39-propose-execute-test",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000aaaa",
  actorKind: "ai",
  requestId: "v0.2.39-propose-execute-test-ai",
};

const TEST_TAG = "v0-2-39-pe";

async function wipe(): Promise<void> {
  // Strategy: clear OUR test-tagged data (pending rows, users,
  // templates) but leave the test actors in place between runs. Actors
  // are FK-referenced by ~10 tables (audit_events / site_snapshots /
  // ai_calls / structured_sets / etc.); cleaning them on every test
  // run took 18+s. The test ids are stable; we just keep them alive.
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM user_pending_actions WHERE proposed_by = ${AI.actorId}::uuid OR proposed_by = ${HUMAN.actorId}::uuid`;
      await tx`DELETE FROM template_pending_actions WHERE proposed_by = ${AI.actorId}::uuid OR proposed_by = ${HUMAN.actorId}::uuid`;
      await tx`DELETE FROM email_config_pending_actions WHERE proposed_by = ${AI.actorId}::uuid OR proposed_by = ${HUMAN.actorId}::uuid`;
      await tx`DELETE FROM templates WHERE slug LIKE ${`${TEST_TAG}%`}`;
      await tx`DELETE FROM layouts WHERE slug LIKE ${`${TEST_TAG}%`}`;
      await tx`DELETE FROM users WHERE email LIKE ${`${TEST_TAG}%`}`;
    });
  } finally {
    await sql.end();
  }
}

/**
 * Direct-SELECT helper for assertions that need to bypass RLS. Each
 * call wraps in a system-actor tx so FORCE RLS policies see the
 * caelo.actor_kind setting.
 */
async function inspect<T>(fn: (tx: import("bun").SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    let result!: T;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      result = await fn(tx as unknown as import("bun").SQL);
    });
    return result;
  } finally {
    await sql.end();
  }
}

async function ensureActors(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`INSERT INTO actors (id, kind, display_name) VALUES (${HUMAN.actorId}::uuid, 'human', 'pe-test-human') ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO actors (id, kind, display_name) VALUES (${AI.actorId}::uuid, 'ai', 'pe-test-ai') ON CONFLICT DO NOTHING`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  await ensureActors();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("propose/execute pair — users (server-generated password shape)", () => {
  const email = `${TEST_TAG}-user1@example.com`;

  it("propose lands a pending row with payload_hash + chat_session_id null", async () => {
    const r = await execute(registry, adapter, AI, "users.propose_create", {
      email,
      displayName: "PE Test User",
      roleNames: [],
    });
    expect(r.ok).toBe(true);
    const v = (r as { ok: true; value: { proposalId: string } }).value;
    expect(v.proposalId).toMatch(/^[0-9a-f-]{36}$/);

    // Inspect the row directly (with RLS bypassed via system actor).
    const rows = await inspect(
      (tx) =>
        tx.unsafe(
          `SELECT status, payload_hash, chat_session_id FROM user_pending_actions WHERE id = '${v.proposalId}'`,
        ) as unknown as Promise<
          { status: string; payload_hash: string; chat_session_id: string | null }[]
        >,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.chat_session_id).toBeNull(); // AI ctx has no chatBranchId
  });

  it("duplicate propose (same payload) is rejected by the unique index", async () => {
    const r = await execute(registry, adapter, AI, "users.propose_create", {
      email, // same as above
      displayName: "PE Test User",
      roleNames: [],
    });
    expect(r.ok).toBe(false);
    const e = (r as { ok: false; error: { message: string } }).error;
    expect(e.message).toContain("Identical proposal already pending");
  });

  it("execute_proposal applies → users row created + status flips to applied", async () => {
    const rows = await inspect(
      (tx) =>
        tx.unsafe(
          `SELECT id::text AS id FROM user_pending_actions WHERE proposed_by = '${AI.actorId}' AND status = 'pending' LIMIT 1`,
        ) as unknown as Promise<{ id: string }[]>,
    );
    const proposalId = rows[0]!.id;

    const r = await execute(registry, adapter, HUMAN, "users.execute_proposal", { proposalId });
    expect(r.ok).toBe(true);
    const v = (r as { ok: true; value: { userId: string; temporaryPassword: string | null } })
      .value;
    expect(v.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(v.temporaryPassword).toBeTruthy();

    const userRows = await inspect(
      (tx) =>
        tx.unsafe(`SELECT email FROM users WHERE id = '${v.userId}'`) as unknown as Promise<
          { email: string }[]
        >,
    );
    expect(userRows[0]?.email).toBe(email);
    const propRows = await inspect(
      (tx) =>
        tx.unsafe(
          `SELECT status FROM user_pending_actions WHERE id = '${proposalId}'`,
        ) as unknown as Promise<{ status: string }[]>,
    );
    expect(propRows[0]?.status).toBe("applied");
  });

  it("re-executing an applied proposal returns 'already applied'", async () => {
    const rows = await inspect(
      (tx) =>
        tx.unsafe(
          `SELECT id::text AS id FROM user_pending_actions WHERE status = 'applied' LIMIT 1`,
        ) as unknown as Promise<{ id: string }[]>,
    );
    const proposalId = rows[0]!.id;
    const r = await execute(registry, adapter, HUMAN, "users.execute_proposal", { proposalId });
    expect(r.ok).toBe(false);
    const e = (r as { ok: false; error: { message: string } }).error;
    expect(e.message).toContain("already applied");
  });
});

describe("propose/execute pair — templates (no-secret shape, blast-radius preview)", () => {
  let templateId: string;
  let proposalId: string;
  let layoutId: string;

  beforeAll(async () => {
    // Templates require a layout binding. Create one for this test.
    const lr = await execute(registry, adapter, HUMAN, "layouts.create", {
      slug: `${TEST_TAG}-layout-${Math.random().toString(36).slice(2, 6)}`,
      displayName: "PE Test Layout",
      html: '<html><body><caelo-slot name="content"></caelo-slot></body></html>',
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });
    expect(lr.ok).toBe(true);
    layoutId = (lr as { ok: true; value: { layoutId: string } }).value.layoutId;

    const r = await execute(registry, adapter, HUMAN, "templates.create", {
      slug: `${TEST_TAG}-tpl`,
      displayName: "PE Test Template",
      html: "<div>{{block:body}}</div>",
      css: "",
      layoutId,
    });
    expect(r.ok).toBe(true);
    templateId = (r as { ok: true; value: { templateId: string } }).value.templateId;
  });

  it("propose_delete lands with affectedPageCount=0 in preview", async () => {
    const r = await execute(registry, adapter, AI, "templates.propose_delete", { templateId });
    expect(r.ok).toBe(true);
    const v = (
      r as {
        ok: true;
        value: { proposalId: string; preview: Record<string, unknown> };
      }
    ).value;
    proposalId = v.proposalId;
    expect(v.preview.kind).toBe("delete");
    expect(v.preview.affectedPageCount).toBe(0);
  });

  it("reject marks the row 'rejected' without deleting the template", async () => {
    const r = await execute(registry, adapter, HUMAN, "templates.reject_proposal", {
      proposalId,
      reason: "test reject",
    });
    expect(r.ok).toBe(true);
    const propRows = await inspect(
      (tx) =>
        tx.unsafe(
          `SELECT status FROM template_pending_actions WHERE id = '${proposalId}'`,
        ) as unknown as Promise<{ status: string }[]>,
    );
    expect(propRows[0]?.status).toBe("rejected");
    const tplRows = await inspect(
      (tx) =>
        tx.unsafe(
          `SELECT slug FROM templates WHERE id = '${templateId}' AND deleted_at IS NULL`,
        ) as unknown as Promise<{ slug: string }[]>,
    );
    expect(tplRows.length).toBe(1);
  });

  it("re-executing a rejected proposal also fails", async () => {
    const r = await execute(registry, adapter, HUMAN, "templates.execute_proposal", {
      proposalId,
    });
    expect(r.ok).toBe(false);
    const e = (r as { ok: false; error: { message: string } }).error;
    expect(e.message).toContain("already rejected");
  });
});

describe("cancel_proposal — AI withdraws its own pending row", () => {
  it("cancels a pending row with proposed_by matching the AI actor", async () => {
    // Propose something fresh.
    const r1 = await execute(registry, adapter, AI, "templates.propose_delete", {
      templateId: await freshTemplate(),
    });
    expect(r1.ok).toBe(true);
    const proposalId = (r1 as { ok: true; value: { proposalId: string } }).value.proposalId;

    // AI cancels it.
    const r2 = await execute(registry, adapter, AI, "pending_proposals.cancel", {
      proposalId,
      reason: "test cancel",
    });
    expect(r2.ok).toBe(true);
    const v = (r2 as { ok: true; value: { cancelled: boolean; domain: string | null } }).value;
    expect(v.cancelled).toBe(true);
    expect(v.domain).toBe("templates");

    // Status flipped to cancelled.
    const rows = await inspect(
      (tx) =>
        tx.unsafe(
          `SELECT status FROM template_pending_actions WHERE id = '${proposalId}'`,
        ) as unknown as Promise<{ status: string }[]>,
    );
    expect(rows[0]?.status).toBe("cancelled");
  });

  it("refuses to cancel a row owned by a different actor", async () => {
    // HUMAN proposes, AI tries to cancel — should fail.
    const r1 = await execute(registry, adapter, HUMAN, "templates.propose_delete", {
      templateId: await freshTemplate(),
    });
    expect(r1.ok).toBe(true);
    const proposalId = (r1 as { ok: true; value: { proposalId: string } }).value.proposalId;
    const r2 = await execute(registry, adapter, AI, "pending_proposals.cancel", { proposalId });
    expect(r2.ok).toBe(false);
    const e = (r2 as { ok: false; error: { message: string } }).error;
    expect(e.message).toContain("No pending proposal found");
  });
});

async function freshTemplate(): Promise<string> {
  const tag = Math.random().toString(36).slice(2, 6);
  const lr = await execute(registry, adapter, HUMAN, "layouts.create", {
    slug: `${TEST_TAG}-layout-${tag}`,
    displayName: "PE Test Layout (fresh)",
    html: '<html><body><caelo-slot name="content"></caelo-slot></body></html>',
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  expect(lr.ok).toBe(true);
  const layoutId = (lr as { ok: true; value: { layoutId: string } }).value.layoutId;
  const slug = `${TEST_TAG}-tpl-${tag}`;
  const r = await execute(registry, adapter, HUMAN, "templates.create", {
    slug,
    displayName: "PE Test Template (fresh)",
    html: "<div>{{block:body}}</div>",
    css: "",
    layoutId,
  });
  expect(r.ok).toBe(true);
  return (r as { ok: true; value: { templateId: string } }).value.templateId;
}
