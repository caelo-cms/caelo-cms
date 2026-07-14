// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — AI-proposed import runs awaiting Owner approval (§11.A queue).
 *
 * issue #297 — approving arms the cost gate: the load computes the ceiling
 * the click will arm (estimate high × safety factor) so the operator sees
 * the number BEFORE approving, and the approve action forwards an explicit
 * budget when the estimate failed (the op rejects a budget-less approval
 * for failed estimates — no NULL-ceiling runs once an estimate was shown).
 */

import {
  deriveCeilingFromEstimate,
  ESTIMATE_CEILING_SAFETY_FACTOR,
  formatMicrocentsAsMoney,
} from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

/** issue #193 — the stored crawl-scope estimate (or its loud failure). */
type ImportEstimate =
  | { failed: true; reason: string }
  | {
      failed?: false;
      pages: number;
      // issue #229 — `list` basis = the exact page-list (LIST) mode.
      basis: "sitemap" | "sample" | "list";
      truncated: boolean;
      crawlMinutes: number;
      aiCostUsd: { low: number; high: number };
    };

interface ImportRun {
  id: string;
  sourceUrl: string;
  depth: number;
  maxPages: number;
  proposedBy: string;
  createdAt: string;
  estimate: ImportEstimate | null;
  /** issue #229 — LIST-mode chosen URLs; null = classic depth/BFS mode. */
  explicitUrls: string[] | null;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "imports.list_pending_proposals", {});
  const runs = r.ok ? (r.value as { runs: ImportRun[] }).runs : [];
  // issue #297 — precompute what Approve will arm, per proposal:
  //  - autoBudget: display string for the derived ceiling (estimate band ok)
  //  - budgetRequired: the estimate cannot fund a ceiling → the form must
  //    collect an explicit budget or the op rejects the approval.
  const annotated = runs.map((run) => {
    if (run.estimate === null) {
      // Legacy rows without a stored estimate approve ceiling-less (pre-#193).
      return { ...run, autoBudget: null, budgetRequired: false };
    }
    const derived = deriveCeilingFromEstimate(run.estimate);
    return derived.ok
      ? {
          ...run,
          autoBudget: formatMicrocentsAsMoney(derived.ceilingMicrocents, derived.currency),
          budgetRequired: false,
        }
      : { ...run, autoBudget: null, budgetRequired: true };
  });
  return {
    runs: annotated,
    safetyFactor: ESTIMATE_CEILING_SAFETY_FACTOR,
    error: r.ok ? null : r.error.kind,
  };
};

export const actions: Actions = {
  approve: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    // The chat's ProposeCard posts `proposalId` (the generic §11.A
    // field name); this queue's native field is `runId`. Accept both —
    // the inline Approve in the chat IS the primary path (operator
    // decision: everything happens in chat context).
    const runId = form.get("runId") ?? form.get("proposalId");
    if (typeof runId !== "string") return fail(400, { error: "runId required" });
    // issue #297 — optional explicit budget (required by the op when the
    // estimate failed). Major units; currency defaults to USD in the op.
    const budgetRaw = form.get("budget");
    let ceiling: number | undefined;
    if (typeof budgetRaw === "string" && budgetRaw.trim() !== "") {
      ceiling = Number(budgetRaw);
      if (!Number.isFinite(ceiling) || ceiling <= 0) {
        return fail(400, { error: "budget must be a positive number (major units, e.g. 10)" });
      }
    }
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "imports.execute_proposal", {
      runId,
      ...(ceiling !== undefined ? { ceiling } : {}),
    });
    if (!r.ok) {
      // Surface the op's actionable message (e.g. "estimate failed — pass
      // an explicit budget"), not just the error kind.
      const message = "message" in r.error ? r.error.message : r.error.kind;
      return fail(400, { error: message });
    }
    const v = r.value as { ceilingMicrocents: number | null; ceilingCurrency: string | null };
    const budgetNote =
      v.ceilingMicrocents !== null && v.ceilingCurrency !== null
        ? ` Cost ceiling armed: ${formatMicrocentsAsMoney(v.ceilingMicrocents, v.ceilingCurrency)}.`
        : "";
    return { ok: true, message: `Approved — worker picks it up within 10s.${budgetNote}` };
  },
  reject: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    // The chat's ProposeCard posts `proposalId` (the generic §11.A
    // field name); this queue's native field is `runId`. Accept both —
    // the inline Approve in the chat IS the primary path (operator
    // decision: everything happens in chat context).
    const runId = form.get("runId") ?? form.get("proposalId");
    const reason = form.get("reason");
    if (typeof runId !== "string") return fail(400, { error: "runId required" });
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "imports.reject_proposal", {
      runId,
      reason: typeof reason === "string" ? reason : undefined,
    });
    if (!r.ok) return fail(400, { error: r.error.kind });
    return { ok: true, message: "Proposal rejected." };
  },
};
