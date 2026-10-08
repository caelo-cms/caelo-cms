// SPDX-License-Identifier: MPL-2.0

import { describeError } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { enqueueStagingAudit } from "#lib/server/quality-audit.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "ops.view");
  const { adapter, registry } = getQueryContext();
  const [targets, runs, gate] = await Promise.all([
    execute(registry, adapter, locals.ctx, "deploy.list_targets", {}),
    execute(registry, adapter, locals.ctx, "deploy.list_runs", { limit: 25 }),
    execute(registry, adapter, locals.ctx, "quality_audits.gate_status", {}),
  ]);
  return {
    // #553 — a production build publishes what is staged, so it shows (and
    // obeys) the staged build's quality gate.
    qualityGate: gate.ok
      ? (
          gate.value as {
            gate: {
              open: boolean;
              state: string;
              message: string;
              canPublishAnyway: boolean;
            } | null;
          }
        ).gate
      : null,
    targets: targets.ok
      ? (
          targets.value as {
            targets: {
              id: string;
              name: string;
              env: string;
              outDir: string;
              robotsDefault: string;
              isDefault: boolean;
            }[];
          }
        ).targets
      : [],
    runs: runs.ok
      ? (
          runs.value as {
            runs: {
              id: string;
              targetName: string;
              env: string;
              status: string;
              startedAt: string;
              finishedAt: string | null;
              pageCount: number | null;
              fileCount: number | null;
              errorMessage: string | null;
              buildId: string | null;
              progress: { pagesDone: number; pagesTotal: number } | null;
            }[];
          }
        ).runs
      : [],
  };
};

export const actions: Actions = {
  trigger: async ({ request, locals }) => {
    requirePermission(locals, "deploy.trigger");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const targetName = String(form.get("targetName") ?? "");
    // #553 — only sent for production while the staged build's quality
    // check failed; deploy.trigger records it as a publish-anyway decision.
    const publishAnywayReason = String(form.get("publishAnywayReason") ?? "").trim();
    const result = await execute(registry, adapter, locals.ctx, "deploy.trigger", {
      targetName,
      ...(publishAnywayReason ? { publishAnyway: { reason: publishAnywayReason } } : {}),
    });
    if (!result.ok) {
      return fail(409, { error: `Build ${targetName} refused: ${describeError(result.error)}` });
    }
    // #553 — a staging rebuild from Ops is audited like any Stage outside
    // a chat (no-op for other targets).
    await enqueueStagingAudit(locals.ctx, {
      deployRunId: (result.value as { runId: string }).runId,
      targetName,
      chatSessionId: null,
      branch: null,
    });
    throw redirect(303, "/security/deployments");
  },
  promote: async ({ request, locals }) => {
    requirePermission(locals, "deploy.trigger");
    requirePermission(locals, "ops.view");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const fromTarget = String(form.get("fromTarget") ?? "");
    const toTarget = String(form.get("toTarget") ?? "");
    const result = await execute(registry, adapter, locals.ctx, "deploy.promote", {
      fromTarget,
      toTarget,
    });
    if (!result.ok) return fail(500, { error: `Promote ${fromTarget} → ${toTarget} failed.` });
    throw redirect(303, "/security/deployments");
  },
};
