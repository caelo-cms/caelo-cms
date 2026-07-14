// SPDX-License-Identifier: MPL-2.0

/**
 * issue #280 — migration cost gate integration.
 *
 *   - imports.set_cost_ceiling stores the operator-confirmed budget.
 *   - imports.get_run_cost sums ai_calls across the run's ORCHESTRATOR
 *     chat session AND every SUBAGENT session under it (subagent_runs),
 *     and rolls up rebuild progress (accepted vs total import_pages).
 *   - the ceiling comparison (overBudget, remaining) tracks spend.
 *
 * issue #297 — the auto-armed gate on top:
 *
 *   - imports.execute_proposal arms ceiling = estimate.high × safety factor
 *     in the approval transaction; a failed estimate REJECTS a budget-less
 *     approval and accepts an explicit one.
 *   - imports.get_session_budget_state resolves the gate from the
 *     orchestrator session AND from a subagent child, with unpriced-call
 *     counting (the run-#14 "$0.00 report" signature).
 *   - imports.record_budget_gate_event claims warn/trip exactly once;
 *     imports.set_cost_ceiling re-arms by clearing both claims.
 *
 * Do not run locally — the shared dev DB truncates. CI runs it against
 * the compose Postgres.
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
let sqlc: SQL;
let runId: string;
let orchestratorId: string;
let subagentSessionId: string;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "issue280-cost-gate",
};

async function cleanup(): Promise<void> {
  await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`DELETE FROM import_pages WHERE source_url LIKE 'https://issue280.example%'`;
    await tx`DELETE FROM import_run_events WHERE run_id IN (SELECT id FROM import_runs WHERE source_url LIKE 'https://issue297.example%')`;
    await tx`DELETE FROM import_runs WHERE source_url LIKE 'https://issue280.example%' OR source_url LIKE 'https://issue297.example%'`;
    await tx`DELETE FROM pages WHERE slug LIKE 'issue280-anchor%'`;
    await tx`DELETE FROM subagent_runs WHERE role = 'issue280_rebuilder' OR role = 'issue297_rebuilder'`;
    await tx`DELETE FROM ai_calls WHERE chat_session_id IN (SELECT id FROM chat_sessions WHERE title LIKE '%issue297%')`;
    await tx`DELETE FROM chat_sessions WHERE title LIKE '%issue280%' OR title LIKE '%issue297%' OR subagent_role IN ('issue280_rebuilder', 'issue297_rebuilder')`;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  sqlc = new SQL(ADMIN_URL!);
  await cleanup();

  // Orchestrator chat + one subagent session under it.
  const orch = await execute(registry, adapter, SYSTEM, "chat.create_session", {
    title: "issue280 orchestrator",
  });
  orchestratorId = (orch.value as { chatSessionId: string }).chatSessionId;
  const sub = await execute(registry, adapter, SYSTEM, "chat.create_session", {
    title: "[subagent] issue280",
    subagentRole: "issue280_rebuilder",
    parentChatSessionId: orchestratorId,
  });
  subagentSessionId = (sub.value as { chatSessionId: string }).chatSessionId;
  await execute(registry, adapter, SYSTEM, "subagent_runs.create_pending", {
    parentChatSessionId: orchestratorId,
    parentMessageId: null,
    subagentChatSessionId: subagentSessionId,
    batchId: null,
    role: "issue280_rebuilder",
    task: "rebuild cluster",
  });

  // Import run + two staged pages; link the run to the orchestrator chat.
  const run = await execute(registry, adapter, SYSTEM, "imports.create_run", {
    sourceUrl: "https://issue280.example/",
    depth: 1,
    maxPages: 10,
  });
  runId = (run.value as { runId: string }).runId;
  await execute(registry, adapter, SYSTEM, "imports.write_extracted_pages", {
    runId,
    pages: [
      {
        sourceUrl: "https://issue280.example/a",
        proposedSlug: "issue280-a",
        proposedTitle: "A",
        proposedModules: [],
        proposedThemeTokens: {},
        signature: "/x/*|s1",
      },
      {
        sourceUrl: "https://issue280.example/b",
        proposedSlug: "issue280-b",
        proposedTitle: "B",
        proposedModules: [],
        proposedThemeTokens: {},
        signature: "/x/*|s1",
      },
    ],
  });

  await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`UPDATE import_runs SET chat_session_id = ${orchestratorId}::uuid WHERE id = ${runId}::uuid`;
    // Accept exactly ONE of the two pages → pagesDone=1, pagesTotal=2.
    const anchor = await tx`
      INSERT INTO pages (slug, locale, title, name, status, template_id, version)
      SELECT 'issue280-anchor', 'en', 'Anchor', 'Anchor', 'draft', id, 1
      FROM templates WHERE deleted_at IS NULL LIMIT 1
      RETURNING id
    `;
    const anchorId = (anchor as unknown as { id: string }[])[0]?.id;
    if (!anchorId) throw new Error("no template available to anchor the test page");
    await tx`UPDATE import_pages
             SET accepted_page_id = ${anchorId}::uuid
             WHERE run_id = ${runId}::uuid AND source_url = 'https://issue280.example/a'`;
  });

  // Spend: 1000µ¢ on the orchestrator + 2500µ¢ on the subagent = 3500µ¢.
  await execute(registry, adapter, SYSTEM, "chat.record_ai_call", {
    chatSessionId: orchestratorId,
    provider: "anthropic",
    model: "fixture",
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 0,
    costEstimateMicrocents: 1000,
    durationMs: 100,
    succeeded: true,
  });
  await execute(registry, adapter, SYSTEM, "chat.record_ai_call", {
    chatSessionId: subagentSessionId,
    provider: "anthropic",
    model: "fixture",
    inputTokens: 200,
    outputTokens: 80,
    cachedTokens: 0,
    costEstimateMicrocents: 2500,
    durationMs: 200,
    succeeded: true,
  });
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
  await sqlc.end();
});

interface RunCost {
  runId: string;
  chatSessionId: string | null;
  spentMicrocents: number;
  callCount: number;
  subagentSessionCount: number;
  ceilingMicrocents: number | null;
  ceilingCurrency: string | null;
  remainingMicrocents: number | null;
  overBudget: boolean;
  extrapolation: {
    spentSoFar: number;
    workDone: number;
    workTotal: number;
    extrapolatedTotal: number | null;
  };
  currencyConversionApplied: boolean;
  currencyNote: string | null;
}

describe("imports cost gate", () => {
  it("sums ai_calls across the orchestrator + every subagent session, and rolls up progress", async () => {
    const r = await execute(registry, adapter, SYSTEM, "imports.get_run_cost", { runId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as RunCost;
    expect(v.chatSessionId).toBe(orchestratorId);
    expect(v.spentMicrocents).toBe(3500);
    expect(v.callCount).toBe(2);
    expect(v.subagentSessionCount).toBe(1);
    // 1 of 2 pages accepted → extrapolated total = 3500 * 2 / 1 = 7000.
    expect(v.extrapolation.workDone).toBe(1);
    expect(v.extrapolation.workTotal).toBe(2);
    expect(v.extrapolation.extrapolatedTotal).toBe(7000);
  });

  it("records a ceiling and reports under-budget with remaining + a non-USD conversion note", async () => {
    // 0.0001 major → 10000µ¢, above the 3500µ¢ spent.
    const set = await execute(registry, adapter, SYSTEM, "imports.set_cost_ceiling", {
      runId,
      ceiling: 0.0001,
      currency: "eur",
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect((set.value as { ceilingMicrocents: number }).ceilingMicrocents).toBe(10000);
    expect((set.value as { currency: string }).currency).toBe("EUR");

    const r = await execute(registry, adapter, SYSTEM, "imports.get_run_cost", { runId });
    if (!r.ok) return;
    const v = r.value as RunCost;
    expect(v.ceilingMicrocents).toBe(10000);
    expect(v.ceilingCurrency).toBe("EUR");
    expect(v.overBudget).toBe(false);
    expect(v.remainingMicrocents).toBe(6500);
    expect(v.currencyConversionApplied).toBe(false);
    expect(v.currencyNote).toContain("without an FX rate");
  });

  it("flags overBudget once the ceiling drops below spend", async () => {
    // 0.00003 major → 3000µ¢, below the 3500µ¢ spent.
    await execute(registry, adapter, SYSTEM, "imports.set_cost_ceiling", {
      runId,
      ceiling: 0.00003,
      currency: "EUR",
    });
    const r = await execute(registry, adapter, SYSTEM, "imports.get_run_cost", { runId });
    if (!r.ok) return;
    const v = r.value as RunCost;
    expect(v.ceilingMicrocents).toBe(3000);
    expect(v.overBudget).toBe(true);
    expect(v.remainingMicrocents).toBe(-500);
  });

  it("rejects a get_run_cost for an unknown run with an actionable message", async () => {
    const r = await execute(registry, adapter, SYSTEM, "imports.get_run_cost", {
      runId: "00000000-0000-4000-8000-000000000280",
    });
    expect(r.ok).toBe(false);
  });
});

const USD = 100_000_000; // microcents per $1

interface ArmedApproval {
  ceilingMicrocents: number | null;
  ceilingCurrency: string | null;
  ceilingSource: "explicit" | "estimate" | "none";
}

interface GateState {
  gate: {
    runId: string;
    ceilingMicrocents: number;
    ceilingCurrency: string;
    spentMicrocents: number;
    callCount: number;
    unpricedCallCount: number;
    estimateLowUsd: number | null;
    estimateHighUsd: number | null;
    warningEmitted: boolean;
    tripped: boolean;
  } | null;
}

describe("issue #297 — auto-armed ceiling + live gate state", () => {
  let sessId: string;
  let childId: string;
  let armedRunId: string;

  it("execute_proposal arms ceiling = estimate.high × safety factor in the approval tx", async () => {
    const sess = await execute(registry, adapter, SYSTEM, "chat.create_session", {
      title: "issue297 orchestrator",
    });
    expect(sess.ok).toBe(true);
    if (!sess.ok) return;
    sessId = (sess.value as { chatSessionId: string }).chatSessionId;
    const branchId = (sess.value as { chatBranchId: string }).chatBranchId;

    // Propose FROM the chat (branch ctx) so the run links to the session.
    const prop = await execute(
      registry,
      adapter,
      { ...SYSTEM, chatBranchId: branchId },
      "imports.propose_run",
      {
        sourceUrl: "https://issue297.example/",
        urls: ["https://issue297.example/a"],
        estimate: {
          pages: 14,
          basis: "list",
          truncated: false,
          crawlMinutes: 1,
          aiCostUsd: { low: 0.28, high: 1.4 },
        },
      },
    );
    expect(prop.ok).toBe(true);
    if (!prop.ok) return;
    armedRunId = (prop.value as { runId: string }).runId;

    const appr = await execute(registry, adapter, SYSTEM, "imports.execute_proposal", {
      runId: armedRunId,
    });
    expect(appr.ok).toBe(true);
    if (!appr.ok) return;
    const v = appr.value as ArmedApproval;
    // Run #15's shown band ($0.28–$1.40) → $4.20 ceiling at factor 3.
    expect(v.ceilingMicrocents).toBe(4.2 * USD);
    expect(v.ceilingCurrency).toBe("USD");
    expect(v.ceilingSource).toBe("estimate");

    const cost = await execute(registry, adapter, SYSTEM, "imports.get_run_cost", {
      runId: armedRunId,
    });
    expect(cost.ok).toBe(true);
    if (!cost.ok) return;
    expect((cost.value as { ceilingMicrocents: number | null }).ceilingMicrocents).toBe(4.2 * USD);
  });

  it("failed estimate: budget-less approval is rejected; an explicit budget arms", async () => {
    const prop = await execute(registry, adapter, SYSTEM, "imports.propose_run", {
      sourceUrl: "https://issue297.example/failed",
      depth: 1,
      maxPages: 5,
      estimate: { failed: true, reason: "no sitemap.xml and homepage 500" },
    });
    expect(prop.ok).toBe(true);
    if (!prop.ok) return;
    const failedRunId = (prop.value as { runId: string }).runId;

    const bare = await execute(registry, adapter, SYSTEM, "imports.execute_proposal", {
      runId: failedRunId,
    });
    expect(bare.ok).toBe(false);
    if (bare.ok) return;
    expect("message" in bare.error ? bare.error.message : "").toContain("explicit budget");

    const withBudget = await execute(registry, adapter, SYSTEM, "imports.execute_proposal", {
      runId: failedRunId,
      ceiling: 7,
      currency: "usd",
    });
    expect(withBudget.ok).toBe(true);
    if (!withBudget.ok) return;
    const v = withBudget.value as ArmedApproval;
    expect(v.ceilingMicrocents).toBe(7 * USD);
    expect(v.ceilingCurrency).toBe("USD");
    expect(v.ceilingSource).toBe("explicit");
  });

  it("get_session_budget_state resolves the gate for orchestrator AND subagent sessions, counting unpriced calls", async () => {
    // One priced call + one call whose (provider, model) has no ai_pricing
    // row — the run-#14 shape: real tokens, cost stored as 0.
    await execute(registry, adapter, SYSTEM, "chat.record_ai_call", {
      chatSessionId: sessId,
      provider: "anthropic",
      model: "fixture",
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 0,
      costEstimateMicrocents: 100_000,
      durationMs: 10,
      succeeded: true,
    });
    await execute(registry, adapter, SYSTEM, "chat.record_ai_call", {
      chatSessionId: sessId,
      provider: "issue297-no-such-provider",
      model: "issue297-no-such-model",
      inputTokens: 110_000,
      outputTokens: 1_500,
      cachedTokens: 0,
      durationMs: 10,
      succeeded: true,
    });

    const state = await execute(registry, adapter, SYSTEM, "imports.get_session_budget_state", {
      chatSessionId: sessId,
    });
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const g = (state.value as GateState).gate;
    expect(g).not.toBeNull();
    if (!g) return;
    expect(g.runId).toBe(armedRunId);
    expect(g.ceilingMicrocents).toBe(4.2 * USD);
    expect(g.spentMicrocents).toBe(100_000);
    expect(g.callCount).toBe(2);
    expect(g.unpricedCallCount).toBe(1);
    expect(g.estimateLowUsd).toBe(0.28);
    expect(g.estimateHighUsd).toBe(1.4);
    expect(g.warningEmitted).toBe(false);
    expect(g.tripped).toBe(false);

    // A subagent child of the orchestrator resolves the SAME gate.
    const child = await execute(registry, adapter, SYSTEM, "chat.create_session", {
      title: "[subagent] issue297",
      subagentRole: "issue297_rebuilder",
      parentChatSessionId: sessId,
    });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    childId = (child.value as { chatSessionId: string }).chatSessionId;
    await execute(registry, adapter, SYSTEM, "subagent_runs.create_pending", {
      parentChatSessionId: sessId,
      parentMessageId: null,
      subagentChatSessionId: childId,
      batchId: null,
      role: "issue297_rebuilder",
      task: "rebuild",
    });
    const childState = await execute(
      registry,
      adapter,
      SYSTEM,
      "imports.get_session_budget_state",
      {
        chatSessionId: childId,
      },
    );
    expect(childState.ok).toBe(true);
    if (!childState.ok) return;
    expect((childState.value as GateState).gate?.runId).toBe(armedRunId);

    // An unrelated session has no gate.
    const other = await execute(registry, adapter, SYSTEM, "chat.create_session", {
      title: "issue297 unrelated",
    });
    if (!other.ok) return;
    const otherState = await execute(
      registry,
      adapter,
      SYSTEM,
      "imports.get_session_budget_state",
      {
        chatSessionId: (other.value as { chatSessionId: string }).chatSessionId,
      },
    );
    expect(otherState.ok).toBe(true);
    if (!otherState.ok) return;
    expect((otherState.value as GateState).gate).toBeNull();
  });

  it("gate events claim exactly once; set_cost_ceiling re-arms both claims", async () => {
    const claim = (kind: "warning" | "tripped") =>
      execute(registry, adapter, SYSTEM, "imports.record_budget_gate_event", {
        runId: armedRunId,
        kind,
        spentMicrocents: 5 * USD,
        ceilingMicrocents: 4.2 * USD,
        message: `issue297 ${kind} fixture`,
      });

    const first = await claim("warning");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect((first.value as { claimed: boolean }).claimed).toBe(true);
    const second = await claim("warning");
    if (!second.ok) return;
    expect((second.value as { claimed: boolean }).claimed).toBe(false);
    const trip = await claim("tripped");
    if (!trip.ok) return;
    expect((trip.value as { claimed: boolean }).claimed).toBe(true);

    const state = await execute(registry, adapter, SYSTEM, "imports.get_session_budget_state", {
      chatSessionId: sessId,
    });
    if (!state.ok) return;
    expect((state.value as GateState).gate?.warningEmitted).toBe(true);
    expect((state.value as GateState).gate?.tripped).toBe(true);

    // Re-arm: a new ceiling clears both claims so the gate fires again.
    const rearm = await execute(registry, adapter, SYSTEM, "imports.set_cost_ceiling", {
      runId: armedRunId,
      ceiling: 10,
      currency: "USD",
    });
    expect(rearm.ok).toBe(true);
    const after = await execute(registry, adapter, SYSTEM, "imports.get_session_budget_state", {
      chatSessionId: sessId,
    });
    if (!after.ok) return;
    const g = (after.value as GateState).gate;
    expect(g?.ceilingMicrocents).toBe(10 * USD);
    expect(g?.warningEmitted).toBe(false);
    expect(g?.tripped).toBe(false);
    const reclaimed = await claim("warning");
    if (!reclaimed.ok) return;
    expect((reclaimed.value as { claimed: boolean }).claimed).toBe(true);
  });

  it("get_run_cost surfaces the unpriced-call count (run #14 $0.00 regression)", async () => {
    const r = await execute(registry, adapter, SYSTEM, "imports.get_run_cost", {
      runId: armedRunId,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as RunCost & { unpricedCallCount: number };
    expect(v.spentMicrocents).toBe(100_000);
    expect(v.callCount).toBe(2);
    expect(v.unpricedCallCount).toBe(1);
  });
});
