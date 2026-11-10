// SPDX-License-Identifier: MPL-2.0

/**
 * POST /api/internal/jobs/<kind>/report — issue #1359 (#1140 category A).
 *
 * Where a reporting job (the quality audit after a Stage) reports to the
 * admin: one request per step — asking for its inputs, handing over
 * progress and its result. The request gives the admin the CPU to answer
 * and record it, so nothing of the job's work relies on an idle admin
 * instance (CLAUDE.md §11.B Tier 5).
 *
 * Who may call it: the kind's own service account through IAP AND the
 * attempt's token (lib/server/reporting-jobs.ts). Everything else is a 401.
 * A report never builds or publishes anything (CLAUDE.md §2).
 */

import { isReportingJobKind } from "@caelo-cms/admin-core";
import { json, type RequestHandler } from "@sveltejs/kit";
import { answerJobReport } from "#lib/server/reporting-jobs.js";

export const POST: RequestHandler = async ({ request, params }) => {
  const kind = params.kind ?? "";
  if (!isReportingJobKind(kind)) {
    return json(
      { ok: false, error: { code: "unknown-kind", message: `no reporting job of kind "${kind}"` } },
      { status: 404 },
    );
  }
  return answerJobReport(request, kind);
};
