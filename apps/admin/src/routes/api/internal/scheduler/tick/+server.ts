// SPDX-License-Identifier: MPL-2.0

/**
 * POST /api/internal/scheduler/tick — issue #1140.
 *
 * The one entry point of the admin's periodic work. The install's scheduler
 * calls it every `schedulerIntervalMinutes` (1–15, default 5); the request
 * runs every task that is due (lib/server/scheduler.ts) and answers when they
 * are done, so the work runs on the request's CPU and nothing relies on an
 * idle instance.
 *
 * Who may call it: the scheduler's own service account through IAP (Google
 * Cloud), or a caller with the internal token of scope `scheduler.tick`
 * (the self-hosted clock, tooling). Both are checked in
 * `authorizeSchedulerTick`; anything else is a 401.
 *
 * The tick never builds or publishes production (CLAUDE.md §2;
 * scripts/no-automatic-production-deploy.test.ts).
 */

import { json, type RequestHandler } from "@sveltejs/kit";
import { authorizeSchedulerTick, runAdminSchedulerTick } from "#lib/server/scheduler.js";

export const POST: RequestHandler = async ({ request }) => {
  const auth = await authorizeSchedulerTick(request);
  if (!auth.ok) return auth.refusal;
  const { via } = auth;
  const report = await runAdminSchedulerTick();
  const failed = report.ran.filter((r) => r.outcome !== "ok");
  if (failed.length > 0) {
    console.error(
      `[scheduler] tick ${report.holder}: ${failed.map((f) => `${f.key} ${f.outcome}`).join(", ")}`,
    );
  }
  // A failed task is the task's problem, recorded on its row and retried at
  // its next due time; the tick itself worked, so the scheduler gets a 200
  // and does not retry the whole tick.
  return json({ ok: true, via, ...report });
};
