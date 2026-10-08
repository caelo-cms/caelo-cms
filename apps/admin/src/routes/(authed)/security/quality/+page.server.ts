// SPDX-License-Identifier: MPL-2.0

/**
 * #553 — the quality view: what the Lighthouse checks of staged builds
 * found, the per-page baselines, what editors accepted (the Owner can
 * revoke it), and every "publish anyway" decision with actor and reason.
 * Read surfaces are the same ops the AI reads; revoking is the Owner's.
 */

import { describeError } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const load: PageServerLoad = async ({ locals, url }) => {
  requirePermission(locals, "ops.view");
  const { adapter, registry } = getQueryContext();
  const selected = url.searchParams.get("run");
  const ctx = locals.ctx;
  const [gate, runs, overrides, baselines, acceptances, detail] = await Promise.all([
    execute(registry, adapter, ctx, "quality_audits.gate_status", {}),
    execute(registry, adapter, ctx, "quality_audits.list", { limit: 30 }),
    execute(registry, adapter, ctx, "quality_audits.list", {
      publishOverrideOnly: true,
      limit: 50,
    }),
    execute(registry, adapter, ctx, "quality_baselines.list", { belowTargetOnly: true }),
    execute(registry, adapter, ctx, "quality_acceptances.list", {
      includeRevoked: true,
      limit: 200,
    }),
    selected && UUID_RE.test(selected)
      ? execute(registry, adapter, ctx, "quality_audits.get", { auditRunId: selected })
      : execute(registry, adapter, ctx, "quality_audits.get", {}),
  ]);
  const errors = [gate, runs, overrides, baselines, acceptances, detail]
    .filter((r) => !r.ok)
    .map((r) => (r.ok ? "" : describeError(r.error)));
  return {
    gate: gate.ok ? (gate.value as QualityGateStatus) : null,
    runs: runs.ok ? (runs.value as { runs: AuditRun[] }).runs : [],
    overrides: overrides.ok ? (overrides.value as { runs: AuditRun[] }).runs : [],
    baselines: baselines.ok ? (baselines.value as { baselines: Baseline[] }).baselines : [],
    acceptances: acceptances.ok
      ? (acceptances.value as { acceptances: Acceptance[] }).acceptances
      : [],
    detail: detail.ok ? (detail.value as AuditDetail) : null,
    canRevoke: locals.user?.permissions.has("settings.write") ?? false,
    loadErrors: errors,
  };
};

export const actions: Actions = {
  revoke: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const acceptanceId = String(form.get("acceptanceId") ?? "");
    const reason = String(form.get("reason") ?? "").trim();
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "quality_acceptances.revoke", {
      acceptanceId,
      ...(reason ? { reason } : {}),
    });
    if (!r.ok) return fail(400, { error: describeError(r.error) });
    return { message: "Acceptance revoked — the finding blocks Publish live on its page again." };
  },
};

interface QualityGateStatus {
  deployRunId: string | null;
  gate: {
    open: boolean;
    state: string;
    auditRunId: string | null;
    message: string;
    canPublishAnyway: boolean;
    openProblemCount: number;
  } | null;
}

interface AuditRun {
  id: string;
  deployRunId: string;
  chatSessionId: string | null;
  status: string;
  classification: { reasons: { rule: string; label: string }[]; skipped: string[] };
  pageCount: number;
  problemCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  fixRound: number;
  publishOverride: { by: string; reason: string; at: string } | null;
  autoPublish: { outcome: string | null; message: string | null } | null;
}

interface Baseline {
  pageId: string;
  pagePath: string;
  category: string;
  baseline: number;
  belowStreak: number;
  updatedAt: string;
}

interface Acceptance {
  id: string;
  pagePath: string;
  kind: "finding" | "score";
  auditId: string | null;
  category: string | null;
  acceptedScore: number | null;
  reason: string;
  acceptedBy: string;
  acceptedAt: string;
  revokedAt: string | null;
}

interface AuditDetail {
  run: AuditRun | null;
  pages: {
    pageId: string;
    pagePath: string;
    url: string;
    status: string;
    scores: Record<string, number> | null;
    baselines: Record<string, number>;
    problems: (
      | { kind: "failing_audit"; auditId: string; title: string; displayValue?: string }
      | { kind: "score_below_baseline"; category: string; score: number; baseline: number }
    )[];
    heldBack: (
      | { kind: "performance_drop"; score: number }
      | { kind: "performance_finding"; auditId: string }
    )[];
    errorMessage: string | null;
  }[];
}
