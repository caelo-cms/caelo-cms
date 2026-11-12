// SPDX-License-Identifier: MPL-2.0

/**
 * Core's quality checks over the op-backed sources the admin answers the
 * audit's job with, without the job's transport. Made per audit: the
 * stored-link issues are the ones the audited build recorded where it
 * started (#1594), and the job's reporter names the audit.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import {
  linkSourcesFromOps,
  recordedLinkCheckFromOps,
  referenceSourcesOf,
} from "../../quality/checks/links-sources.js";
import {
  type CheckRegistry,
  createCoreCheckRegistry,
  type LighthouseRunner,
} from "../../quality/checks/registry.js";
import { structureSourcesFromOps } from "../../quality/checks/structure-sources.js";
import type { JobReporter } from "../../reporting-jobs/job-reporter.js";

/** `drainAuditQueue`'s `checks`: core's registry for the audit the reporter runs. */
export function coreChecksOverOps(
  deps: { readonly registry: OperationRegistry; readonly adapter: DatabaseAdapter },
  ctx: ExecutionContext,
  lighthouse: LighthouseRunner,
): (reporter: JobReporter) => CheckRegistry {
  const { registry, adapter } = deps;
  return (reporter) => {
    const recorded = recordedLinkCheckFromOps(registry, adapter, ctx, reporter.subjectId);
    return createCoreCheckRegistry({
      lighthouse,
      structure: structureSourcesFromOps(registry, adapter, ctx),
      links: linkSourcesFromOps(registry, adapter, ctx, recorded),
      references: referenceSourcesOf(recorded),
    });
  };
}
