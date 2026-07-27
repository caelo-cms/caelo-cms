// SPDX-License-Identifier: MPL-2.0

/**
 * `set_migration_budget` is human-approval-gated (CLAUDE.md §11.A).
 *
 * The regression this pins: on 2026-07-27 the tool was guarded only by the
 * sentence "Do NOT invent a ceiling the operator never confirmed" in its own
 * description. Thirty-nine seconds after the budget gate warned at 86% of a
 * $7.89 ceiling, the AI called it and raised the ceiling to $100 by itself —
 * `audit_events` records `actor_kind = ai`. An instruction is not a guard.
 *
 * The gate is unconditional on purpose. Lowering a ceiling is harmless, but
 * `needsApproval` receives only `(input, ctx)` — no adapter — so it cannot
 * read the current ceiling to tell the directions apart. A money figure gets
 * the click rather than a guess.
 */

import { describe, expect, it } from "bun:test";

import type { ExecutionContext } from "@caelo-cms/shared";
import { type ToolContext, ToolRegistry } from "../dispatch.js";
import { setMigrationBudgetTool } from "../migration-budget.js";

const ctx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000001",
  actorKind: "ai",
  requestId: "set-migration-budget-approval-test",
};

const RUN_ID = "55393716-581e-42ba-98fe-ebd0520283bb";
const input = (ceiling: number, currency = "USD") => ({ runId: RUN_ID, ceiling, currency });

describe("set_migration_budget — operator approval gate", () => {
  it("declares needsApproval + buildApprovalPreview", () => {
    expect(typeof setMigrationBudgetTool.needsApproval).toBe("function");
    expect(typeof setMigrationBudgetTool.buildApprovalPreview).toBe("function");
  });

  it("gates a raise — the exact shape that went through unapproved", async () => {
    expect(await setMigrationBudgetTool.needsApproval!(input(100), ctx)).toBe(true);
  });

  it("gates a lowering too, since the predicate cannot read the current ceiling", async () => {
    expect(await setMigrationBudgetTool.needsApproval!(input(1), ctx)).toBe(true);
  });

  it("gates regardless of currency or magnitude", async () => {
    expect(await setMigrationBudgetTool.needsApproval!(input(10, "EUR"), ctx)).toBe(true);
    expect(await setMigrationBudgetTool.needsApproval!(input(999_999, "GBP"), ctx)).toBe(true);
  });

  it("dispatch short-circuits before the handler runs", async () => {
    const reg = new ToolRegistry();
    reg.register(setMigrationBudgetTool);
    // No adapter in toolCtx: if the handler were reached it would throw, so a
    // clean result proves the gate intercepted the call.
    const result = await reg.dispatch("set_migration_budget", input(100), ctx, {} as ToolContext);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("set_migration_budget");
    expect(result.content).toContain("[needs-approval, non-persisted]");
  });

  it("the preview shows the operator the amount they are approving", async () => {
    const preview = await setMigrationBudgetTool.buildApprovalPreview!(input(100), ctx);
    expect(preview).toMatchObject({
      op: "set_migration_budget",
      runId: RUN_ID,
      proposedCeiling: 100,
      currency: "USD",
    });
  });

  it("the description states the two-step contract and drops the stale 3x claim", () => {
    const d = setMigrationBudgetTool.description;
    expect(d).toContain("TWO-STEP");
    expect(d).toContain("Do not claim the budget was applied");
    // ESTIMATE_CEILING_SAFETY_FACTOR is 1; the description used to promise 3x.
    expect(d).not.toContain("3x");
  });
});
