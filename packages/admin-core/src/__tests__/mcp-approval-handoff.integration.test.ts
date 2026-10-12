// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #658 — an approval-gated call from an external agent (Power-MCP)
 * is recorded as requested by that agent; the operator's decision in the
 * admin is handed back to the agent (mcp.get_approval_outcome) and never
 * shows up as a message in the shared chat session, i.e. it cannot start
 * a Live Edit AI turn. A proposal the chat's own AI queued keeps its old
 * shape (no origin), which is what makes ChatPanel auto-continue it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { decisionFromRow } from "../ops/mcp_approval_handoffs.js";
import { configureMcpBridge } from "../ops/security/mcp_tokens.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "mcp-handoff-test",
};
const ownerCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000002",
  actorKind: "human",
  requestId: "mcp-handoff-test-owner",
};
/** The operator who clicks Approve/Reject — holds the Owner role. */
const approverCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000065a8",
  actorKind: "human",
  requestId: "mcp-handoff-test-approver",
};
const otherCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000003",
  actorKind: "human",
  requestId: "mcp-handoff-test-other",
};

async function withSystemTx<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

async function ensureActor(actorId: string, displayName: string): Promise<void> {
  await withSystemTx(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name)
             VALUES (${actorId}::uuid, 'human', ${displayName})
             ON CONFLICT (id) DO NOTHING`;
  });
}

async function mintAdminToken(ctx: ExecutionContext): Promise<string> {
  const r = await execute(registry, adapter, ctx, "mcp_tokens.create", {
    displayName: `handoff-test-${crypto.randomUUID().slice(0, 8)}`,
    scope: "admin",
  });
  if (!r.ok) throw new Error(`token mint failed: ${JSON.stringify(r.error)}`);
  return (r.value as { plaintextToken: string }).plaintextToken;
}

async function messageCount(chatSessionId: string): Promise<number> {
  return withSystemTx(async (tx) => {
    const rows = await tx`SELECT count(*)::int AS c FROM chat_messages
                          WHERE chat_session_id = ${chatSessionId}::uuid`;
    return (rows[0] as { c: number }).c;
  });
}

let adminToken: string;
let otherToken: string;
let chatSessionId: string;
let chatBranchId: string;

async function proposeOverMcp(
  displayName: string,
  toolCallId?: string,
): Promise<{ proposalId: string; domain: string; content: string }> {
  const r = await execute(registry, adapter, systemCtx, "mcp.execute_tool", {
    plaintextToken: adminToken,
    chatSessionId,
    toolName: "propose_create_mcp_token",
    args: { displayName },
    ...(toolCallId ? { toolCallId } : {}),
  });
  if (!r.ok) throw new Error(`execute_tool failed: ${JSON.stringify(r.error)}`);
  const v = r.value as {
    content: string;
    approval?: { proposalId: string; domain: string } | null;
  };
  if (!v.approval) throw new Error(`no approval handle: ${v.content}`);
  return { ...v.approval, content: v.content };
}

async function outcomeFor(token: string, proposalId: string) {
  return execute(registry, adapter, systemCtx, "mcp.get_approval_outcome", {
    plaintextToken: token,
    proposalId,
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL!, publicDatabaseUrl: PUBLIC_URL! });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await ensureActor(ownerCtx.actorId, "mcp-handoff owner");
  await ensureActor(otherCtx.actorId, "mcp-handoff other");
  await withSystemTx(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name)
             VALUES (${approverCtx.actorId}::uuid, 'human', 'mcp-handoff approver')
             ON CONFLICT (id) DO NOTHING`;
    await tx`INSERT INTO users (id, email, password_hash)
             VALUES (${approverCtx.actorId}::uuid, 'approver@mcp-handoff.test', 'test-only')
             ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO user_roles (user_id, role_id)
             SELECT ${approverCtx.actorId}::uuid, id FROM roles WHERE name = 'owner'
             ON CONFLICT DO NOTHING`;
  });
  configureMcpBridge({ adapter, registry, resolveProvider: async () => null });
  adminToken = await mintAdminToken(ownerCtx);
  otherToken = await mintAdminToken(otherCtx);
  const opened = await execute(registry, adapter, systemCtx, "mcp.open_session", {
    plaintextToken: adminToken,
    newSession: true,
    title: "mcp-handoff-test session",
  });
  if (!opened.ok) throw new Error(`open_session failed: ${JSON.stringify(opened.error)}`);
  const s = opened.value as { chatSessionId: string; chatBranchId: string };
  chatSessionId = s.chatSessionId;
  chatBranchId = s.chatBranchId;
});

afterAll(async () => {
  await withSystemTx(async (tx) => {
    await tx`DELETE FROM mcp_approval_handoffs WHERE chat_session_id = ${chatSessionId}::uuid`;
    await tx`DELETE FROM mcp_tokens WHERE actor_id IN (${ownerCtx.actorId}::uuid, ${otherCtx.actorId}::uuid)`;
  });
});

describe("MCP-originated approval → decided in the admin → handed back", () => {
  it("records the origin and marks the pending card as requested by the external agent", async () => {
    const p = await proposeOverMcp(`handoff-origin-${crypto.randomUUID().slice(0, 6)}`);
    expect(p.domain).toBe("mcp_tokens");
    expect(p.content).toMatch(/^Queued proposal [0-9a-f-]{36}:/);

    const listed = await execute(registry, adapter, ownerCtx, "pending_proposals.list", {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const item = (
      listed.value as {
        items: Array<{
          proposalId: string;
          chatSessionId: string | null;
          requestedVia: string | null;
        }>;
      }
    ).items.find((i) => i.proposalId === p.proposalId);
    expect(item?.chatSessionId).toBe(chatSessionId);
    expect(item?.requestedVia).toBe("power_mcp");

    const before = await outcomeFor(adminToken, p.proposalId);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect((before.value as { outcome: string }).outcome).toBe("pending");
  });

  it("approve: applies, hands 'applied' back to the MCP, and adds nothing to the chat session", async () => {
    const p = await proposeOverMcp(`handoff-approve-${crypto.randomUUID().slice(0, 6)}`);
    const messagesBefore = await messageCount(chatSessionId);

    // The operator's click (what the Live Edit strip's Approve posts to).
    const approved = await execute(registry, adapter, approverCtx, "mcp_tokens.execute_proposal", {
      proposalId: p.proposalId,
    });
    expect(approved.ok).toBe(true);

    const out = await outcomeFor(adminToken, p.proposalId);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const v = out.value as { outcome: string; decidedAt: string | null; toolName: string };
    expect(v.outcome).toBe("applied");
    expect(v.decidedAt).not.toBeNull();
    expect(v.toolName).toBe("propose_create_mcp_token");

    // The card's status line: decided + picked up by the agent.
    const handoffs = await execute(registry, adapter, ownerCtx, "mcp_approval_handoffs.list", {
      chatSessionId,
    });
    expect(handoffs.ok).toBe(true);
    if (!handoffs.ok) return;
    const h = (
      handoffs.value as {
        handoffs: Array<{ proposalId: string; outcome: string; deliveredAt: string | null }>;
      }
    ).handoffs.find((x) => x.proposalId === p.proposalId);
    expect(h?.outcome).toBe("applied");
    expect(h?.deliveredAt).not.toBeNull();

    // No Live Edit AI turn: nothing was appended to the shared session.
    expect(await messageCount(chatSessionId)).toBe(messagesBefore);
  });

  it("reject: the MCP gets 'rejected' with the operator's reason", async () => {
    const p = await proposeOverMcp(`handoff-reject-${crypto.randomUUID().slice(0, 6)}`);
    const rejected = await execute(registry, adapter, approverCtx, "mcp_tokens.reject_proposal", {
      proposalId: p.proposalId,
      reason: "not this one",
    });
    expect(rejected.ok).toBe(true);
    const out = await outcomeFor(adminToken, p.proposalId);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value as { outcome: string; detail: string | null }).toMatchObject({
      outcome: "rejected",
      detail: "not this one",
    });
  });

  it("the MCP can only read its own hand-offs, and cannot approve", async () => {
    const p = await proposeOverMcp(`handoff-owner-${crypto.randomUUID().slice(0, 6)}`);
    const foreign = await outcomeFor(otherToken, p.proposalId);
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect("message" in foreign.error ? foreign.error.message : "").toMatch(/^approval_not_found:/);

    // The executor stays out of reach of the AI actor (no auto-approve).
    const self = await execute(
      registry,
      adapter,
      { actorId: ownerCtx.actorId, actorKind: "ai", requestId: "ai-self-approve" },
      "mcp_tokens.execute_proposal",
      { proposalId: p.proposalId },
    );
    expect(self.ok).toBe(false);
    const still = await outcomeFor(adminToken, p.proposalId);
    expect(still.ok && (still.value as { outcome: string }).outcome).toBe("pending");
  });

  it("a cached replay of the same toolCallId returns the same handle without a second row", async () => {
    const callId = `handoff-replay-${crypto.randomUUID()}`;
    const first = await proposeOverMcp(`handoff-replay-${crypto.randomUUID().slice(0, 6)}`, callId);
    const second = await proposeOverMcp("ignored-on-replay", callId);
    expect(second.proposalId).toBe(first.proposalId);
    const rows = await withSystemTx(
      async (tx) =>
        tx`SELECT count(*)::int AS c FROM mcp_approval_handoffs WHERE proposal_id = ${first.proposalId}::uuid`,
    );
    expect((rows[0] as { c: number }).c).toBe(1);
  });

  it("needsApproval calls: in-flight while dispatching, then the tool result is handed back", async () => {
    const r = await execute(registry, adapter, systemCtx, "mcp.execute_tool", {
      plaintextToken: adminToken,
      chatSessionId,
      toolName: "delete_pages_many",
      args: {
        deletions: Array.from({ length: 5 }, () => ({
          pageId: crypto.randomUUID(),
          disposition: "404",
        })),
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const approval = (r.value as { approval?: { proposalId: string; domain: string } | null })
      .approval;
    expect(approval?.domain).toBe("tool_approvals");
    if (!approval) return;

    // The approve route claims the row first (status → applied) …
    const claim = await execute(registry, adapter, approverCtx, "tool_approvals.read_for_execute", {
      proposalId: approval.proposalId,
    });
    expect(claim.ok).toBe(true);
    const inFlight = await outcomeFor(adminToken, approval.proposalId);
    expect(inFlight.ok && (inFlight.value as { outcome: string }).outcome).toBe("pending");

    // … then records the dispatch result, which is what the agent receives.
    await execute(registry, adapter, approverCtx, "tool_approvals.mark_result", {
      proposalId: approval.proposalId,
      ok: true,
      summary: "deleted 0 pages; 5 not found",
    });
    const done = await outcomeFor(adminToken, approval.proposalId);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value as { outcome: string; detail: string | null }).toMatchObject({
      outcome: "applied",
      detail: "deleted 0 pages; 5 not found",
    });
  });
});

describe("a proposal the chat's own AI queued is unchanged", () => {
  it("carries no origin, so the Live Edit chat keeps auto-continuing its AI", async () => {
    const aiCtx: ExecutionContext = {
      actorId: ownerCtx.actorId,
      actorKind: "ai",
      requestId: "live-edit-ai",
      chatBranchId,
      chatTaskId: chatSessionId,
    };
    const proposed = await execute(registry, adapter, aiCtx, "mcp_tokens.propose_create", {
      displayName: `handoff-chat-${crypto.randomUUID().slice(0, 6)}`,
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    const proposalId = (proposed.value as { proposalId: string }).proposalId;

    const listed = await execute(registry, adapter, ownerCtx, "pending_proposals.list", {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const item = (
      listed.value as {
        items: Array<{
          proposalId: string;
          chatSessionId: string | null;
          requestedVia: string | null;
        }>;
      }
    ).items.find((i) => i.proposalId === proposalId);
    expect(item?.chatSessionId).toBe(chatSessionId);
    expect(item?.requestedVia).toBeNull();

    // Not an MCP proposal: the agent cannot read it as its own.
    const out = await outcomeFor(adminToken, proposalId);
    expect(out.ok).toBe(false);
  });
});

describe("decisionFromRow (lifecycle mapping)", () => {
  const base = { decided_at: null, reason: null, result_ok: null, result_summary: null };
  it("maps every source lifecycle onto the agent's outcome", () => {
    expect(decisionFromRow({ ...base, domain: "layouts", status: "pending" }).outcome).toBe(
      "pending",
    );
    expect(decisionFromRow({ ...base, domain: "skills", status: "accepted" }).outcome).toBe(
      "applied",
    );
    expect(decisionFromRow({ ...base, domain: "themes", status: "cancelled" }).outcome).toBe(
      "withdrawn",
    );
    expect(
      decisionFromRow({ ...base, domain: "tool_approvals", status: "applied", result_ok: false })
        .outcome,
    ).toBe("failed");
    expect(decisionFromRow({ ...base, domain: "import", status: "crawling" })).toEqual({
      outcome: "applied",
      detail: "crawl approved (status: crawling)",
    });
    expect(
      decisionFromRow({ ...base, domain: "import", status: "failed", reason: "rejected by Owner" }),
    ).toEqual({ outcome: "rejected", detail: "rejected by Owner" });
    expect(decisionFromRow({ ...base, domain: "layouts", status: "bogus" }).outcome).toBe("failed");
  });
});
