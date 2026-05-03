// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { PageServerLoad } from "./$types";

interface RunRow {
  id: string;
  parentChatSessionId: string | null;
  subagentChatSessionId: string;
  batchId: string | null;
  role: string;
  task: string;
  status: "pending" | "running" | "completed" | "errored" | "timed_out" | "cancelled";
  resultJson: unknown;
  costMicrocents: number;
  durationMs: number;
  errorMessage: string | null;
  createdAt: string;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "subagent_runs.list", { limit: 100 });
  const runs = r.ok ? (r.value as { runs: RunRow[] }).runs : [];
  return { runs };
};
