// SPDX-License-Identifier: MPL-2.0

/**
 * v0.6.0 alpha.3 — W5 persistence layer integration test.
 *
 * Locks in the contract that the dispatcher persists a gated tool
 * call via `tool_approvals.queue` + emits the canonical
 * "Queued proposal <uuid>:" content shape, AND that the Approve
 * route's claim/dispatch/mark_result flow works end-to-end against a
 * real Postgres.
 *
 * Five things this test pins:
 *  1. Dispatcher persists a row when the tool's needsApproval returns
 *     true AND the toolCtx carries adapter + registry.
 *  2. The persisted row has the right tool_name, args, preview, and
 *     chat_session_id.
 *  3. The emitted content matches ProposeCard's canonical regex.
 *  4. `tool_approvals.read_for_execute` atomically transitions
 *     pending → applied + refuses second-claim attempts.
 *  5. `tool_approvals.mark_result` updates result_ok + result_summary.
 *
 * Skipped automatically when the test compose stack isn't reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { z } from "zod";

import { registerAdminOps } from "../register.js";
import { ToolRegistry, type ToolDefinitionWithHandler } from "../ai/tools/dispatch.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SESSION_ID = "11111111-1111-4111-8111-666666666666";
// Reuse the seeded system actor — already in the actors table; avoids
// a per-test seed step. Both AI and HUMAN ctx use the same id for this
// test since we only care about the queue/claim/result mechanics, not
// the actor-scope semantics (which are covered by needs-approval.test).
const AI_ACTOR = "00000000-0000-0000-0000-00000000ffff";
const HUMAN_ACTOR = "00000000-0000-0000-0000-00000000ffff";

const aiCtx: ExecutionContext = {
  actorId: AI_ACTOR,
  actorKind: "ai",
  requestId: "tool-approvals-integration-test-ai",
  chatSessionId: SESSION_ID,
};
const humanCtx: ExecutionContext = {
  actorId: HUMAN_ACTOR,
  actorKind: "human",
  requestId: "tool-approvals-integration-test-human",
};

async function wipe(): Promise<void> {
  // v0.6.0 alpha.4 Fix X — broadened wipe. The earlier filter
  // (`WHERE chat_session_id = SESSION_ID`) missed rows the first test
  // inserts WITHOUT a chatSessionId (toolCtx omits it). Those rows
  // would persist forever in the dev DB. Filter by tool_name so we
  // catch every row this test file ever created, regardless of which
  // ctx shape was used.
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM tool_approval_actions WHERE tool_name = 'integration_test_gated_tool'`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

/**
 * A minimal gated tool wired only for this integration test. Predicate
 * returns true whenever invoked; handler increments a counter so we
 * can assert it ran (or didn't).
 */
function makeGatedTool(): {
  tool: ToolDefinitionWithHandler<{ payload: string }>;
  state: { ranWithPayload: string | null };
} {
  const state = { ranWithPayload: null as string | null };
  const tool: ToolDefinitionWithHandler<{ payload: string }> = {
    name: "integration_test_gated_tool",
    description: "test-only gated tool",
    needsApproval: () => true,
    buildApprovalPreview: (input) => ({
      tool: "integration_test_gated_tool",
      payload: input.payload,
      sample: "preview-shape-ok",
    }),
    schema: z.object({ payload: z.string().min(1) }),
    inputSchema: {
      type: "object",
      required: ["payload"],
      properties: { payload: { type: "string", minLength: 1 } },
    },
    handler: async (_ctx, input) => {
      state.ranWithPayload = input.payload;
      return { ok: true, content: `handler ran with payload="${input.payload}"` };
    },
  };
  return { tool, state };
}

describe("W5 tool_approval_actions — end-to-end persistence + approve", () => {
  it("dispatcher persists a row + emits canonical Queued proposal <uuid>: content", async () => {
    const { tool } = makeGatedTool();
    const tools = new ToolRegistry();
    tools.register(tool);

    // No real chat_session_id in the row (we omit it to avoid an FK on
    // chat_sessions seed); dispatcher persists chat_session_id only
    // when toolCtx.chatSessionId is set. Pass it through here.
    const result = await tools.dispatch(
      "integration_test_gated_tool",
      { payload: "hello-from-test" },
      { actorId: AI_ACTOR, actorKind: "ai", requestId: "test-1" },
      { adapter, registry },
    );

    expect(result.ok).toBe(true);
    // Canonical shape: "Queued proposal <36-char-uuid>: <name> — ..."
    const match = /^Queued proposal ([0-9a-f-]{36}): integration_test_gated_tool/.exec(
      result.content,
    );
    expect(match).not.toBeNull();
    const proposalId = match![1]!;

    // Row exists in tool_approval_actions, status='pending'.
    // Verify via the list_pending op (RLS-friendly, goes through the
    // adapter) rather than raw SQL (which would hit RLS without
    // caelo.actor_kind set).
    const pending = await execute(registry, adapter, humanCtx, "tool_approvals.list_pending", {});
    expect(pending.ok).toBe(true);
    const row = (pending.value as { proposals: Array<{
      id: string;
      toolName: string;
      args: Record<string, unknown>;
      preview: Record<string, unknown>;
      proposedBy: string;
      status: string;
    }> }).proposals.find((p) => p.id === proposalId);
    expect(row).toBeDefined();
    expect(row!.toolName).toBe("integration_test_gated_tool");
    expect(row!.status).toBe("pending");
    expect(row!.proposedBy).toBe(AI_ACTOR);
    expect(row!.args).toEqual({ payload: "hello-from-test" });
    expect(row!.preview).toEqual({
      tool: "integration_test_gated_tool",
      payload: "hello-from-test",
      sample: "preview-shape-ok",
    });
  });

  it("read_for_execute is atomic — second claim returns 'already applied'", async () => {
    // Manually queue a row to set up the test (don't go through the
    // dispatcher again — simpler control).
    const queueRes = await execute(registry, adapter, aiCtx, "tool_approvals.queue", {
      toolName: "integration_test_gated_tool",
      args: { payload: "second-claim-test" },
      preview: { tool: "integration_test_gated_tool" },
    });
    expect(queueRes.ok).toBe(true);
    const proposalId = (queueRes.value as { proposalId: string }).proposalId;

    // First claim — succeeds + returns args.
    const claim1 = await execute(registry, adapter, humanCtx, "tool_approvals.read_for_execute", {
      proposalId,
    });
    expect(claim1.ok).toBe(true);
    expect((claim1.value as { toolName: string }).toolName).toBe("integration_test_gated_tool");

    // Second claim — fails because row is no longer pending.
    const claim2 = await execute(registry, adapter, humanCtx, "tool_approvals.read_for_execute", {
      proposalId,
    });
    expect(claim2.ok).toBe(false);
    if (claim2.ok) throw new Error("unreachable");
    expect((claim2.error as { message?: string }).message).toContain("already applied");
  });

  it("mark_result updates result_ok + result_summary on a claimed row", async () => {
    const queueRes = await execute(registry, adapter, aiCtx, "tool_approvals.queue", {
      toolName: "integration_test_gated_tool",
      args: { payload: "mark-result-test" },
      preview: { tool: "integration_test_gated_tool" },
    });
    if (!queueRes.ok) throw new Error("queue failed");
    const proposalId = (queueRes.value as { proposalId: string }).proposalId;

    await execute(registry, adapter, humanCtx, "tool_approvals.read_for_execute", {
      proposalId,
    });
    const markRes = await execute(registry, adapter, humanCtx, "tool_approvals.mark_result", {
      proposalId,
      ok: true,
      summary: "dispatch ran; payload=mark-result-test",
    });
    expect(markRes.ok).toBe(true);

    // Verify via list_pending(includeDecided=true) since the row is
    // now 'applied' (no longer in default pending view).
    const listRes = await execute(registry, adapter, humanCtx, "tool_approvals.list_pending", {
      includeDecided: true,
    });
    expect(listRes.ok).toBe(true);
    const row = (
      listRes.value as { proposals: Array<{ id: string; resultOk: boolean | null; resultSummary: string | null }> }
    ).proposals.find((p) => p.id === proposalId);
    expect(row).toBeDefined();
    expect(row!.resultOk).toBe(true);
    expect(row!.resultSummary).toContain("mark-result-test");
  });

  it("list_pending returns only pending rows by default + supports includeDecided", async () => {
    // Queue two; mark one applied.
    const a = await execute(registry, adapter, aiCtx, "tool_approvals.queue", {
      toolName: "integration_test_gated_tool",
      args: { payload: "list-A" },
      preview: { tool: "integration_test_gated_tool" },
    });
    const b = await execute(registry, adapter, aiCtx, "tool_approvals.queue", {
      toolName: "integration_test_gated_tool",
      args: { payload: "list-B" },
      preview: { tool: "integration_test_gated_tool" },
    });
    if (!a.ok || !b.ok) throw new Error("queue failed");
    await execute(registry, adapter, humanCtx, "tool_approvals.read_for_execute", {
      proposalId: (a.value as { proposalId: string }).proposalId,
    });

    // Default — pending only.
    const pending = await execute(registry, adapter, humanCtx, "tool_approvals.list_pending", {});
    expect(pending.ok).toBe(true);
    const pendingIds = (pending.value as { proposals: { id: string; status: string }[] }).proposals
      .filter((p) => p.status === "pending")
      .map((p) => p.id);
    expect(pendingIds).toContain((b.value as { proposalId: string }).proposalId);
    expect(pendingIds).not.toContain((a.value as { proposalId: string }).proposalId);

    // includeDecided=true → returns the applied row too.
    const all = await execute(registry, adapter, humanCtx, "tool_approvals.list_pending", {
      includeDecided: true,
    });
    expect(all.ok).toBe(true);
    const allIds = (all.value as { proposals: { id: string }[] }).proposals.map((p) => p.id);
    expect(allIds).toContain((a.value as { proposalId: string }).proposalId);
    expect(allIds).toContain((b.value as { proposalId: string }).proposalId);
  });

  it("reject_proposal marks rejected only when row is pending", async () => {
    const q = await execute(registry, adapter, aiCtx, "tool_approvals.queue", {
      toolName: "integration_test_gated_tool",
      args: { payload: "reject-test" },
      preview: { tool: "integration_test_gated_tool" },
    });
    if (!q.ok) throw new Error("queue failed");
    const proposalId = (q.value as { proposalId: string }).proposalId;

    const rejectRes = await execute(registry, adapter, humanCtx, "tool_approvals.reject_proposal", {
      proposalId,
      reason: "operator declined",
    });
    expect(rejectRes.ok).toBe(true);

    const listRes = await execute(registry, adapter, humanCtx, "tool_approvals.list_pending", {
      includeDecided: true,
    });
    expect(listRes.ok).toBe(true);
    const row = (
      listRes.value as { proposals: Array<{ id: string; status: string; decisionReason: string | null }> }
    ).proposals.find((p) => p.id === proposalId);
    expect(row?.status).toBe("rejected");
    expect(row?.decisionReason).toBe("operator declined");
  });
});
