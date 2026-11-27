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
    // A token only resolves for a live user holding a role.
    await tx`INSERT INTO users (id, email, password_hash)
             VALUES (${actorId}::uuid, ${`${actorId}@mcp-handoff.test`}, 'test-only')
             ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO user_roles (user_id, role_id)
             SELECT ${actorId}::uuid, id FROM roles WHERE name = 'editor'
             ON CONFLICT DO NOTHING`;
  });
}

async function mintAdminToken(ctx: ExecutionContext): Promise<string> {
  const r = await execute(registry, adapter, ctx, "mcp_tokens.create", {
    displayName: `handoff-test-${crypto.randomUUID().slice(0, 8)}`,
    scope: "power",
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
    const displayName = `handoff-replay-${crypto.randomUUID().slice(0, 6)}`;
    const first = await proposeOverMcp(displayName, callId);
    const second = await proposeOverMcp(displayName, callId);
    expect(second.proposalId).toBe(first.proposalId);
    const rows = await withSystemTx(
      async (tx) =>
        tx`SELECT count(*)::int AS c FROM mcp_approval_handoffs WHERE proposal_id = ${first.proposalId}::uuid`,
    );
    expect((rows[0] as { c: number }).c).toBe(1);
    // #1704 — another call under the key is not a replay: refused, and it
    // neither gets the first call's handle nor queues a proposal of its own.
    const other = await execute(registry, adapter, systemCtx, "mcp.execute_tool", {
      plaintextToken: adminToken,
      chatSessionId,
      toolName: "propose_create_mcp_token",
      args: { displayName: "another-call-same-key" },
      toolCallId: callId,
    });
    expect(!other.ok && "message" in other.error && other.error.message).toContain(
      "tool_call_id_reused",
    );
    const queued = await withSystemTx(
      async (tx) =>
        tx`SELECT count(*)::int AS c FROM mcp_approval_handoffs WHERE chat_session_id = ${chatSessionId}::uuid AND tool_call_id = ${callId}`,
    );
    expect((queued[0] as { c: number }).c).toBe(1);
  });

  it("needsApproval calls: in-flight while dispatching, then the tool result is handed back", async () => {
    const r = await execute(registry, adapter, systemCtx, "mcp.execute_tool", {
      plaintextToken: adminToken,
      chatSessionId,
      toolName: "delete_pages_many",
      args: {
        items: Array.from({ length: 5 }, () => ({
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

describe("bespoke proposal flows (non-canonical result wording)", () => {
  it("site_memory_propose hands its Owner review back to the agent", async () => {
    const r = await execute(registry, adapter, systemCtx, "mcp.execute_tool", {
      plaintextToken: adminToken,
      chatSessionId,
      toolName: "site_memory_propose",
      args: {
        slot: "glossary",
        body: `handoff-e2e glossary ${crypto.randomUUID().slice(0, 6)}`,
        rationale: "test",
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const approval = (r.value as { approval?: { proposalId: string; domain: string } | null })
      .approval;
    expect(approval?.domain).toBe("site_memory");
    if (!approval) return;
    const reviewed = await execute(registry, adapter, approverCtx, "ai_memory.review", {
      proposalId: approval.proposalId,
      decision: "reject",
    });
    expect(reviewed.ok).toBe(true);
    const out = await outcomeFor(adminToken, approval.proposalId);
    expect(out.ok && (out.value as { outcome: string }).outcome).toBe("rejected");
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
    // #678 — owner_settings hands its effect (with the next step) back.
    expect(
      decisionFromRow({
        ...base,
        domain: "owner_settings",
        status: "applied",
        result_summary: "Nothing is served at https://p.example.com/ until the next Stage",
      }),
    ).toEqual({
      outcome: "applied",
      detail: "Nothing is served at https://p.example.com/ until the next Stage",
    });
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
    // Approved (approved_at set → result_ok), then the crawl failed: not a reject.
    expect(
      decisionFromRow({
        ...base,
        domain: "import",
        status: "failed",
        reason: "crawl timed out",
        result_ok: true,
      }),
    ).toEqual({ outcome: "failed", detail: "crawl timed out" });
    expect(decisionFromRow({ ...base, domain: "layouts", status: "bogus" }).outcome).toBe("failed");
  });
});

/**
 * #1591 — an approved propose_deploy_promote over MCP read "Not applied yet
 * — the Owner approves it at /settings/deployments/pending." and then "it is
 * now in effect on the draft". Every approval that acts on the live site
 * hands back what it put live, and the summary keeps none of the request's
 * "Not applied yet" wording.
 */
describe("approvals that act on the live site hand back what they put live (#1591)", () => {
  type Outcome = { outcome: string; summary: string; detail: string | null };

  /** A finished run of `target`, as Stage / Publish live / a rollback records it. */
  async function seedRun(
    target: "staging" | "production",
    buildId: string,
    opts: { id?: string; minutesAgo?: number } = {},
  ): Promise<string> {
    const id = opts.id ?? crypto.randomUUID();
    const ago = opts.minutesAgo ?? 0;
    await withSystemTx(async (tx) => {
      await tx`INSERT INTO deploy_runs (id, target_id, actor_id, status, started_at, finished_at, build_id)
               SELECT ${id}::uuid, t.id, ${approverCtx.actorId}::uuid, 'succeeded',
                      now() - make_interval(mins => ${ago}), now() - make_interval(mins => ${ago}),
                      ${buildId}
               FROM deploy_targets t WHERE t.name = ${target}`;
    });
    return id;
  }

  async function queueOverMcp(toolName: string, args: Record<string, unknown>) {
    const r = await execute(registry, adapter, systemCtx, "mcp.execute_tool", {
      plaintextToken: adminToken,
      chatSessionId,
      toolName,
      args,
    });
    if (!r.ok) throw new Error(`execute_tool failed: ${JSON.stringify(r.error)}`);
    const v = r.value as { content: string; approval?: { proposalId: string; domain: string } };
    if (!v.approval) throw new Error(`no approval handle: ${v.content}`);
    // The request itself still says it waits for the click.
    expect(v.content).toContain("Not applied yet");
    return v.approval;
  }

  /** The approval as deploy.execute_proposal runs it, with the run it starts in between. */
  async function approveDeploy(proposalId: string, liveBuildId: string): Promise<string> {
    const runId = crypto.randomUUID();
    const begun = await execute(registry, adapter, approverCtx, "deploy.begin_execute_proposal", {
      proposalId,
      runId,
    });
    expect(begun.ok).toBe(true);
    await seedRun("production", liveBuildId, { id: runId });
    const ended = await execute(registry, adapter, approverCtx, "deploy.end_execute_proposal", {
      proposalId,
      claimedRunId: runId,
      outcome: { ok: true, runId },
    });
    expect(ended.ok).toBe(true);
    return runId;
  }

  async function outcomeOf(proposalId: string): Promise<Outcome> {
    const out = await outcomeFor(adminToken, proposalId);
    if (!out.ok) throw new Error(`get_approval_outcome failed: ${JSON.stringify(out.error)}`);
    const v = out.value as Outcome;
    // Nothing of the request's "waiting for the click" wording, no draft.
    expect(`${v.summary} ${v.detail ?? ""}`).not.toMatch(/Not applied yet|draft/i);
    return v;
  }

  it("an approved propose_deploy_promote: it published build <id> to production", async () => {
    const staged = `b1591-staged-${crypto.randomUUID().slice(0, 8)}`;
    await seedRun("staging", staged);
    const approval = await queueOverMcp("propose_deploy_promote", {
      fromTarget: "staging",
      toTarget: "production",
    });
    expect(approval.domain).toBe("deploy");
    const live = `b1591-live-${crypto.randomUUID().slice(0, 8)}`;
    const runId = await approveDeploy(approval.proposalId, live);

    const v = await outcomeOf(approval.proposalId);
    expect(v.outcome).toBe("applied");
    expect(v.summary).toBe(`promote staging → production (build=${staged}, pages=0, files=0)`);
    expect(v.detail).toBe(
      `Published build ${live} to production (run ${runId}): it is live on the site now.`,
    );
  });

  it("an approved propose_deploy_rollback: production serves the restored build", async () => {
    await seedRun("production", `b1591-older-${crypto.randomUUID().slice(0, 8)}`, {
      minutesAgo: 120,
    });
    await seedRun("production", `b1591-newer-${crypto.randomUUID().slice(0, 8)}`, {
      minutesAgo: 60,
    });
    const approval = await queueOverMcp("propose_deploy_rollback", { target: "production" });
    const preview = await withSystemTx(
      async (tx) =>
        (await tx`SELECT preview->>'restoreBuildId' AS restore
                  FROM deploy_pending_actions WHERE id = ${approval.proposalId}::uuid`) as unknown as {
          restore: string;
        }[],
    );
    const restored = preview[0]?.restore ?? "";
    const runId = await approveDeploy(approval.proposalId, restored);

    const v = await outcomeOf(approval.proposalId);
    expect(v.outcome).toBe("applied");
    expect(v.detail).toBe(
      `Rolled production back to build ${restored} (run ${runId}): the live site serves that build now.`,
    );
  });

  it("an approved publish anyway: it published the build over the failed check", async () => {
    const live = `b1591-anyway-${crypto.randomUUID().slice(0, 8)}`;
    const runId = await seedRun("production", live);
    const proposalId = crypto.randomUUID();
    await withSystemTx(async (tx) => {
      await tx`INSERT INTO quality_pending_actions
                 (id, kind, proposed_by, payload, preview, chat_session_id)
               VALUES (${proposalId}::uuid, 'publish_anyway', ${ownerCtx.actorId}::uuid,
                       '{}'::jsonb, '{}'::jsonb, ${chatSessionId}::uuid)`;
      await tx`INSERT INTO mcp_approval_handoffs
                 (proposal_id, domain, chat_session_id, requested_by, tool_name, tool_call_id, summary)
               VALUES (${proposalId}::uuid, 'quality', ${chatSessionId}::uuid,
                       ${ownerCtx.actorId}::uuid, 'publish_despite_failed_audit', 'call-1591',
                       'publish despite the failed audit')`;
    });
    const ended = await execute(
      registry,
      adapter,
      approverCtx,
      "quality_audits.end_execute_proposal",
      { proposalId, claimedRunId: runId, toRunId: runId, message: null },
    );
    expect(ended.ok).toBe(true);

    const v = await outcomeOf(proposalId);
    expect(v.outcome).toBe("applied");
    expect(v.detail).toBe(
      `Published build ${live} to production over the failed quality check (run ${runId}): it is live on the site now.`,
    );
  });

  it("a redirect approval hands back what it recorded at the approval (Go live now)", async () => {
    const proposalId = crypto.randomUUID();
    const effect = "Live now without a Publish live (Go live now): /t1591-a → /t1591-b (301).";
    await withSystemTx(async (tx) => {
      await tx`INSERT INTO redirect_pending_actions
                 (id, kind, proposed_by, payload, preview, status, decided_at, decided_by, chat_session_id)
               VALUES (${proposalId}::uuid, 'go_live_now', ${ownerCtx.actorId}::uuid, '{}'::jsonb,
                       ${JSON.stringify({ appliedEffect: effect })}::text::jsonb, 'applied', now(),
                       ${approverCtx.actorId}::uuid, ${chatSessionId}::uuid)`;
      await tx`INSERT INTO mcp_approval_handoffs
                 (proposal_id, domain, chat_session_id, requested_by, tool_name, tool_call_id, summary)
               VALUES (${proposalId}::uuid, 'redirects', ${chatSessionId}::uuid,
                       ${ownerCtx.actorId}::uuid, 'update_redirect_changes', 'call-1591-r',
                       'go live now without Publish live: /t1591-a → /t1591-b (301)')`;
    });
    const v = await outcomeOf(proposalId);
    expect(v).toMatchObject({ outcome: "applied", detail: effect });
  });
});
