// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1359 — every kind of reporting job the admin runs, by name. A new
 * kind adds its name to protocol.ts `REPORTING_JOB_KINDS` and its
 * definition here; the type makes both required.
 */

import { qualityAuditJobKind } from "../quality/audit-job-kind.js";
import { siteImportJobKind } from "../site-import/import-job-kind.js";
import type { ReportingJobKindDef } from "./kind.js";
import { FOUNDATION_ACTIONS, type ReportingJobKind } from "./protocol.js";

const KINDS: Readonly<Record<ReportingJobKind, ReportingJobKindDef>> = {
  quality_audit: qualityAuditJobKind,
  site_import: siteImportJobKind,
};

// The shared actions are answered before a kind's own (dispatch.ts): a kind
// action of the same name would never run. A bug, so it stops the admin.
for (const def of Object.values(KINDS)) {
  const shadowed = Object.keys(def.actions).filter((a) =>
    (FOUNDATION_ACTIONS as readonly string[]).includes(a),
  );
  if (shadowed.length > 0) {
    throw new Error(`reporting job ${def.kind} declares shared action(s) ${shadowed.join(", ")}`);
  }
}

/** The definition of `kind`. */
export function reportingJobKind(kind: ReportingJobKind): ReportingJobKindDef {
  return KINDS[kind];
}

/** Every kind, in a fixed order (the backstop's). */
export function reportingJobKinds(): readonly ReportingJobKindDef[] {
  return Object.values(KINDS);
}
