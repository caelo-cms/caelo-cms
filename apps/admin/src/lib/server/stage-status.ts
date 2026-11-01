// SPDX-License-Identifier: MPL-2.0

import { describeError } from "@caelo-cms/admin-core";
import type { QueryError } from "@caelo-cms/query-api";
import type { Result, StageStatusRun } from "@caelo-cms/shared";

/**
 * #1288 — the Stage statuses of a `deploy.stage_status` result, or the
 * reason they could not be read; Settings → Deployments shows the reason
 * instead of silently showing no estimate.
 */
export function stageStatusOf(r: Result<unknown, QueryError>): {
  stageStatus: StageStatusRun[];
  stageStatusError: string | null;
} {
  return r.ok
    ? { stageStatus: (r.value as { runs: StageStatusRun[] }).runs, stageStatusError: null }
    : { stageStatus: [], stageStatusError: describeError(r.error) };
}
