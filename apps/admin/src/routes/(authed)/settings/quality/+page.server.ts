// SPDX-License-Identifier: MPL-2.0

/**
 * #553 / #727 — the quality view: what the checks of staged builds found
 * (the page checks on every page, Lighthouse when it ran; every page held
 * to 100 and zero findings), what editors accepted — grouped per decision,
 * so the Owner reviews and revokes a bulk acceptance as one — and every
 * "publish anyway" decision with actor and reason. Read surfaces are the
 * same ops the AI reads; revoking is the Owner's.
 */

import { describeError } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import type { AcceptanceRow } from "#lib/quality-acceptance-groups.js";
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
  const [gate, runs, overrides, acceptances, detail] = await Promise.all([
    execute(registry, adapter, ctx, "quality_audits.gate_status", {}),
    execute(registry, adapter, ctx, "quality_audits.list", { limit: 30 }),
    execute(registry, adapter, ctx, "quality_audits.list", {
      publishOverrideOnly: true,
      limit: 50,
    }),
    execute(registry, adapter, ctx, "quality_acceptances.list", {
      includeRevoked: true,
      limit: 500,
    }),
    selected && UUID_RE.test(selected)
      ? execute(registry, adapter, ctx, "quality_audits.get", { auditRunId: selected })
      : execute(registry, adapter, ctx, "quality_audits.get", {}),
  ]);
  const errors = [gate, runs, overrides, acceptances, detail]
    .filter((r) => !r.ok)
    .map((r) => (r.ok ? "" : describeError(r.error)));
  return {
    gate: gate.ok ? (gate.value as QualityGateStatus) : null,
    runs: runs.ok ? (runs.value as { runs: AuditRun[] }).runs : [],
    overrides: overrides.ok ? (overrides.value as { runs: AuditRun[] }).runs : [],
    acceptances: acceptances.ok
      ? (acceptances.value as { acceptances: AcceptanceRow[] }).acceptances
      : [],
    detail: detail.ok ? (detail.value as AuditDetail) : null,
    canRevoke: locals.user?.permissions.has("settings.write") ?? false,
    loadErrors: errors,
  };
};

export const actions: Actions = {
  /**
   * #727 — revoke one acceptance, a picked set, or a whole bulk decision
   * (every `acceptanceIds` the form posts) in one all-or-nothing call.
   */
  revoke: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const acceptanceIds = form
      .getAll("acceptanceIds")
      .map((v) => String(v))
      .filter((v) => UUID_RE.test(v));
    if (acceptanceIds.length === 0) {
      return fail(400, { error: "Choose at least one acceptance to revoke." });
    }
    const reason = String(form.get("reason") ?? "").trim();
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "quality_acceptances.revoke_many", {
      acceptanceIds,
      ...(reason ? { reason } : {}),
    });
    if (!r.ok) return fail(400, { error: describeError(r.error) });
    const revoked = (r.value as { revoked: number }).revoked;
    return {
      message: `${revoked} acceptance(s) revoked — those findings block Publish live on their pages again.`,
    };
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
  classification: {
    auditNeeded: boolean;
    reasons: { rule: string; label: string }[];
    skipped: string[];
  };
  pageCount: number;
  checkSummary: { checkIds: string[]; pagesChecked: number } | null;
  problemCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  fixRound: number;
  publishOverride: { by: string; reason: string; at: string } | null;
  autoPublish: { outcome: string | null; message: string | null } | null;
}

interface AuditDetail {
  run: AuditRun | null;
  pages: {
    pageId: string;
    pagePath: string;
    url: string;
    status: string;
    scores: Record<string, number> | null;
    metrics: PerformanceMetrics | null;
    problems: (
      | { kind: "failing_audit"; auditId: string; title: string; displayValue?: string }
      | { kind: "score_below_baseline"; category: string; score: number }
      | CheckRuleProblem
    )[];
    /** Per problem: a live acceptance covers it (#727). */
    problemAccepted: boolean[];
    checkFindings: CheckFinding[];
    errorMessage: string | null;
  }[];
  checks: {
    siteProblems: CheckRuleProblem[];
    siteFindings: CheckFinding[];
    errors: { checkId: string | null; message: string }[];
  } | null;
  siteProblemAccepted: boolean[];
}

interface CheckRuleProblem {
  kind: "check_rule";
  ruleId: string;
  count: number;
  allowed: number;
  findings: { message: string }[];
}

interface CheckFinding {
  ruleId: string;
  severity: "error" | "warning" | "info";
  message: string;
}

/** `quality_audits.get` page metrics (admin-core lighthouse-metrics.ts). */
interface PerformanceMetrics {
  runs: number;
  metrics: {
    id: string;
    label: string;
    title: string;
    displayValue: string | null;
    score: number | null;
    unavailableReason: string | null;
  }[];
  lcpElement: { selector?: string; label?: string } | null;
  lcpBreakdown: { subpart: string; label: string; durationMs: number }[];
  layoutShifts: {
    element: { selector?: string; label?: string };
    score: number;
    causes: string[];
  }[];
}
