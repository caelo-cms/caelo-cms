// SPDX-License-Identifier: MPL-2.0
import { describeError } from "@caelo-cms/admin-core";
/**
 * #1288 — the Stage statuses of a `deploy.stage_status` result, or the
 * reason they could not be read; Settings → Deployments shows the reason
 * instead of silently showing no estimate.
 */
export function stageStatusOf(r) {
    return r.ok
        ? { stageStatus: r.value.runs, stageStatusError: null }
        : { stageStatus: [], stageStatusError: describeError(r.error) };
}
