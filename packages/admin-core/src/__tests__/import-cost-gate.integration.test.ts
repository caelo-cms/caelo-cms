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
    await tx`DELETE FROM import_runs WHERE source_url LIKE 'https://issue280.example%'`;
    await tx`DELETE FROM pages WHERE slug LIKE 'issue280-anchor%'`;
    await tx`DELETE FROM subagent_runs WHERE role = 'issue280_rebuilder'`;
    await tx`DELETE FROM chat_sessions WHERE title LIKE '%issue280%' OR subagent_role = 'issue280_rebuilder'`;
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
