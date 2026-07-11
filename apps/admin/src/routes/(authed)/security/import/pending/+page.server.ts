// SPDX-License-Identifier: MPL-2.0

/**
 * P14 — AI-proposed import runs awaiting Owner approval (§11.A queue).
 */

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
      basis: "sitemap" | "sample";
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
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "imports.list_pending_proposals", {});
  const runs = r.ok ? (r.value as { runs: ImportRun[] }).runs : [];
  return { runs, error: r.ok ? null : r.error.kind };
};

export const actions: Actions = {
  approve: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const runId = form.get("runId");
    if (typeof runId !== "string") return fail(400, { error: "runId required" });
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "imports.execute_proposal", {
      runId,
    });
    if (!r.ok) return fail(400, { error: r.error.kind });
    return { ok: true, message: "Approved — worker picks it up within 10s." };
  },
  reject: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const runId = form.get("runId");
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
