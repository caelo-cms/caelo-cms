// SPDX-License-Identifier: MPL-2.0

import { describeError, executeBuild } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import { stageStatusOf } from "#lib/server/stage-status.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "ops.view");
  const { adapter, registry } = getQueryContext();
  const [targets, runs, gate, stage] = await Promise.all([
    execute(registry, adapter, locals.ctx, "deploy.list_targets", {}),
    execute(registry, adapter, locals.ctx, "deploy.list_runs", { limit: 25 }),
    execute(registry, adapter, locals.ctx, "quality_audits.gate_status", {}),
    // #1288 — the Stage runs' step, progress and estimated time left.
    execute(registry, adapter, locals.ctx, "deploy.stage_status", { limit: 20 }),
  ]);
  return {
    ...stageStatusOf(stage),
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
              buildKind: "site" | "plugin_data";
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
    // #553 / #1319 — a staging rebuild from Ops is audited like any Stage
    // outside a chat; deploy.trigger queues the audit with the build.
    // #1574 — inside the request a carrier job holds open (a closed tab does not stop it).
    const result = await executeBuild({ adapter, registry }, locals.ctx, "deploy.trigger", {
      targetName,
      ...(publishAnywayReason ? { publishAnyway: { reason: publishAnywayReason } } : {}),
    });
    if (!result.ok) {
      return fail(409, { error: `Build ${targetName} refused: ${describeError(result.error)}` });
    }
    // #1574 — a redirect would drop the warning of a build run without its carrier.
    if (result.warning) return { ok: `Built ${targetName}.`, carrierWarning: result.warning };
    throw redirect(303, "/settings/deployments");
  },
  promote: async ({ request, locals }) => {
    requirePermission(locals, "deploy.trigger");
    requirePermission(locals, "ops.view");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const fromTarget = String(form.get("fromTarget") ?? "");
    const toTarget = String(form.get("toTarget") ?? "");
    // #1574 — inside the request a carrier job holds open (a closed tab does not stop it).
    const result = await executeBuild({ adapter, registry }, locals.ctx, "deploy.promote", {
      fromTarget,
      toTarget,
    });
    if (!result.ok) return fail(500, { error: `Promote ${fromTarget} → ${toTarget} failed.` });
    // #1454 — a redirect would drop what the operator must read.
    const notice = (result.value as { securityHeadersNote?: string }).securityHeadersNote;
    const carrier = result.warning ? { carrierWarning: result.warning } : {};
    if (notice || result.warning) {
      return { published: { targetName: toTarget, ...(notice ? { notice } : {}) }, ...carrier };
    }
    throw redirect(303, "/settings/deployments");
  },
};
