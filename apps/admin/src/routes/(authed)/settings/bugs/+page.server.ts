// SPDX-License-Identifier: MPL-2.0

/**
 * "Detected bugs" — operator-facing view of `ai_bug_reports`, the defects
 * the AI filed while working (see `ops/ai/bug-reports.ts`), plus the
 * Owner's choice whether they go to the Caelo team (epic #901,
 * `ops/ai/bug-forwarding.ts`). The Markdown / JSON export stays for
 * installs that keep forwarding off.
 */

import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

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
  /** 'ai' = model-filed via bug_report; 'auto' = chat-runner auto-captured. */
  source: string;
  /** Where the report went (#902): local_only | queued | sent | failed. */
  forwardingState: "local_only" | "queued" | "sent" | "failed";
  forwardError: string | null;
  /** Once sent: open | fixed | regression | wontfix. */
  upstreamStatus: "open" | "fixed" | "regression" | "wontfix" | null;
  upstreamIssueUrl: string | null;
  upstreamFixedIn: string | null;
}

export interface BugForwarding {
  enabled: boolean;
  decidedAt: string | null;
  counts: {
    localOnly: number;
    queued: number;
    sent: number;
    failed: number;
    earlierUnsent: number;
  };
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.read");
  const { adapter, registry } = getQueryContext();
  const [r, f] = await Promise.all([
    execute(registry, adapter, locals.ctx, "ai_bug_reports.list", { limit: 200 }),
    execute(registry, adapter, locals.ctx, "bug_forwarding.get", {}),
  ]);
  if (!f.ok) throw new Error(`bug_forwarding.get: ${JSON.stringify(f.error)}`);
  const reports: BugReport[] = r.ok ? (r.value as { reports: BugReport[] }).reports : [];
  return { reports, forwarding: f.value as BugForwarding };
};

export const actions: Actions = {
  setForwarding: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const enabled = form.get("enabled") === "1";
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "bug_forwarding.set", { enabled });
    if (!r.ok) return fail(400, { error: "Could not save the setting." });
    return {
      ok: enabled
        ? "Detected bugs are now sent to the Caelo team."
        : "Detected bugs stay on this site.",
    };
  },
  queueEarlier: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, locals.ctx, "bug_forwarding.queue_earlier", {});
    if (!r.ok) return fail(400, { error: "Turn on sending to the Caelo team first." });
    const { queued } = r.value as { queued: number };
    return { ok: `${queued} earlier report(s) will be sent to the Caelo team.` };
  },
};
