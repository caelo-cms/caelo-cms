// SPDX-License-Identifier: MPL-2.0

/**
 * #1764 — Settings → Deployments' Cloud capacity card: the project's Cloud
 * Run CPU quota and what it lets the jobs run at once, read live (no cache:
 * a raised quota shows on the next page load).
 */

import {
  capacityLimited,
  MAX_JOB_TASKS,
  MAX_LIGHTHOUSE_TASKS,
  quotaConsoleUrl,
  type RunCapacity,
  readInstallRunCapacity,
} from "@caelo-cms/admin-core";
import { RUN_CPU_QUOTA_METRIC } from "@caelo-cms/shared";

export type CloudCapacityView =
  /** No Cloud Run quota on this provider: the card is not shown. */
  | { readonly state: "none" }
  | { readonly state: "error"; readonly message: string }
  | {
      readonly state: "ok";
      readonly capacity: RunCapacity;
      readonly limited: boolean;
      /** Rounds a full quality check (15 runs) takes at this width. */
      readonly checkRounds: number;
      readonly maxLighthouseTasks: number;
      readonly maxIndexTasks: number;
      readonly consoleUrl: string;
      readonly metric: string;
    };

/** The card's view from a capacity, or why there is none. Pure; exported for tests. */
export function cloudCapacityView(capacity: RunCapacity | null): CloudCapacityView {
  if (capacity === null) return { state: "none" };
  return {
    state: "ok",
    capacity,
    limited: capacityLimited(capacity),
    checkRounds: Math.ceil(MAX_LIGHTHOUSE_TASKS / capacity.lighthouseTasks),
    maxLighthouseTasks: MAX_LIGHTHOUSE_TASKS,
    maxIndexTasks: MAX_JOB_TASKS,
    consoleUrl: quotaConsoleUrl(capacity.projectId),
    metric: RUN_CPU_QUOTA_METRIC,
  };
}

/** Read this install's capacity for the card; a failed read is shown, not hidden. */
export async function loadCloudCapacity(
  read: () => Promise<RunCapacity | null> = () => readInstallRunCapacity(),
): Promise<CloudCapacityView> {
  try {
    return cloudCapacityView(await read());
  } catch (e) {
    return {
      state: "error",
      message: `The project's Cloud Run CPU quota could not be read: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
