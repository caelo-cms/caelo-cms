// SPDX-License-Identifier: MPL-2.0

/**
 * "Detected bugs" — operator-facing view of `ai_bug_reports`, the defects
 * the AI filed while working (see `ops/ai/bug-reports.ts`). Read-only list
 * plus a client-side export (Markdown for a GitHub issue, or JSON) so an
 * operator hitting a problem can hand us a self-contained report.
 */

import { execute } from "@caelo-cms/query-api";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { PageServerLoad } from "./$types";

export interface BugReport {
  id: string;
  createdAt: string;
  chatSessionId: string | null;
  title: string;
  whatHappened: string;
  expected: string;
  suspectedTool: string | null;
  evidence: string | null;
  severity: string;
  blockedTask: boolean;
  status: string;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.read");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "ai_bug_reports.list", { limit: 200 });
  const reports: BugReport[] = r.ok ? (r.value as { reports: BugReport[] }).reports : [];
  return { reports };
};
