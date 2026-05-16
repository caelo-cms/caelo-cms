// SPDX-License-Identifier: MPL-2.0

/**
 * v0.6.0 W5 reference migration — `delete_pages_many` approval gate.
 *
 * Verifies that the W5 `needsApproval` predicate fires at the
 * documented threshold (5 pages). Below the threshold the handler
 * would run normally (we can't test the handler without a DB, but we
 * confirm the dispatcher does NOT short-circuit). At/above, the
 * dispatcher returns the canonical "Queued proposal" result without
 * touching the handler.
 *
 * This test pins the threshold so future tuning is intentional —
 * raising it silently would weaken the gate.
 */

import { describe, expect, it } from "bun:test";

import type { ExecutionContext } from "@caelo-cms/shared";
import { deletePagesManyTool } from "../bulk-pages-modules.js";
import { ToolRegistry, type ToolContext } from "../dispatch.js";

const ctx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000001",
  actorKind: "ai",
  requestId: "delete-pages-many-approval-test",
};

const toolCtx = {} as unknown as ToolContext;

function ids(n: number): string[] {
  // Valid v4 UUIDs — Zod enforces variant bits (third group starts
  // with 1-8, fourth with 8/9/a/b). Last group is the only one we
  // increment for uniqueness, so we get n distinct UUIDs.
  return Array.from({ length: n }, (_v, i) => {
    const tail = (i + 1).toString(16).padStart(12, "0");
    return `11111111-1111-4111-8111-${tail}`;
  });
}

describe("delete_pages_many — W5 reference needsApproval gate", () => {
  it("declares needsApproval + buildApprovalPreview", () => {
    expect(typeof deletePagesManyTool.needsApproval).toBe("function");
    expect(typeof deletePagesManyTool.buildApprovalPreview).toBe("function");
  });

  it("does NOT gate for 1 page (below threshold)", async () => {
    const gated = await deletePagesManyTool.needsApproval!({ pageIds: ids(1) }, ctx);
    expect(gated).toBe(false);
  });

  it("does NOT gate for 4 pages (just below threshold)", async () => {
    const gated = await deletePagesManyTool.needsApproval!({ pageIds: ids(4) }, ctx);
    expect(gated).toBe(false);
  });

  it("DOES gate at exactly 5 pages (threshold)", async () => {
    const gated = await deletePagesManyTool.needsApproval!({ pageIds: ids(5) }, ctx);
    expect(gated).toBe(true);
  });

  it("DOES gate at 50 pages (well above threshold)", async () => {
    const gated = await deletePagesManyTool.needsApproval!({ pageIds: ids(50) }, ctx);
    expect(gated).toBe(true);
  });

  it("ToolRegistry.dispatch routes through the gate end-to-end", async () => {
    const reg = new ToolRegistry();
    reg.register(deletePagesManyTool);
    // 6 pages → over threshold; dispatch should return the canonical
    // "Queued proposal" result WITHOUT calling the handler (no DB
    // adapter wired in toolCtx → handler would throw if reached).
    const result = await reg.dispatch(
      "delete_pages_many",
      { pageIds: ids(6) },
      ctx,
      toolCtx,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Queued proposal");
    expect(result.content).toContain("delete_pages_many");
    expect(result.content).toContain("Click Approve");
  });

  it("buildApprovalPreview surfaces the page count + sample IDs", async () => {
    const preview = await deletePagesManyTool.buildApprovalPreview!(
      { pageIds: ids(20) },
      ctx,
    );
    expect(preview.op).toBe("delete_pages_many");
    expect(preview.pageCount).toBe(20);
    expect(Array.isArray(preview.samplePageIds)).toBe(true);
    expect((preview.samplePageIds as string[]).length).toBe(5);
  });
});
