// SPDX-License-Identifier: MPL-2.0

/**
 * #1764, #1776 — Settings → Deployments' Job capacity card: the CPU the
 * jobs of this install may use (on Google Cloud the project's Cloud Run CPU
 * quota, read live: a raised quota shows on the next page load; a
 * self-hosted install runs one job of each kind at a time in the admin),
 * what that lets each kind of job run, which jobs run and wait right now,
 * and how an Owner makes them faster.
 */

import {
  type CapacityBooking,
  type CapacityReading,
  CHECK_FULL_SPEED_VCPU,
  FULL_SPEED_VCPU,
  indexTasksAlone,
  inProcessBudget,
  lighthouseRunsFor,
  MAX_JOB_TASKS,
  MAX_LIGHTHOUSE_TASKS,
  quotaBudget,
  quotaConsoleUrl,
  readInstallRunQuota,
} from "@caelo-cms/admin-core";
import { RUN_CPU_QUOTA_METRIC } from "@caelo-cms/shared";

/** One line of the card's "Now" list. */
export interface CapacityJobLine {
  /** Which work it is (kind and subject): the row's identity. */
  readonly key: string;
  /** What it is, for people ("Search index", "Plugin job"). */
  readonly label: string;
  readonly state: "running" | "waiting";
  /** vCPU it holds or keeps free (a quality check's Lighthouse share counts). */
  readonly vcpu: number;
  /** "6 of 32 tasks" for elastic work, "2 at once" for screenshots, null for one task. */
  readonly width: string | null;
  /** Why it waits, in operator words. */
  readonly reason: string | null;
  readonly since: string;
}

export type CloudCapacityView =
  /** No job budget on this provider (AWS / Azure until their jobs exist): the card is not shown. */
  | { readonly state: "none" }
  | { readonly state: "error"; readonly message: string }
  | {
      readonly state: "ok";
      readonly reading: CapacityReading;
      /** The quota keeps a job below its full width (Google Cloud only). */
      readonly limited: boolean;
      /** Lighthouse runs at once next to a narrow index, and the rounds of a full check. */
      readonly lighthouseRuns: number;
      readonly checkRounds: number;
      /** Search index tasks between quality checks. */
      readonly indexTasks: number;
      readonly maxLighthouseTasks: number;
      readonly maxIndexTasks: number;
      readonly checkFullSpeedVcpu: number;
      readonly fullSpeedVcpu: number;
      /** What runs and waits now; null when the ledger could not be read. */
      readonly jobs: readonly CapacityJobLine[] | null;
      readonly consoleUrl: string | null;
      readonly metric: string;
    };

const LABELS: Readonly<Record<string, string>> = {
  quality_audit: "Quality check",
  collection_index: "Search index",
  plugin_batch: "Plugin job",
  site_import: "Site import",
  build: "Build",
  capture: "Screenshots",
};

/** The "Now" list of the ledger's bookings, running first. Pure; exported for tests. */
export function jobLines(bookings: readonly CapacityBooking[]): CapacityJobLine[] {
  return [...bookings]
    .sort((a, b) =>
      a.state === b.state ? a.since.localeCompare(b.since) : a.state === "running" ? -1 : 1,
    )
    .map((b) => ({
      key: `${b.kind}/${b.subjectId}`,
      label: LABELS[b.kind] ?? b.kind,
      state: b.state,
      vcpu: b.vcpu + b.reserveVcpu,
      width:
        b.kind === "capture"
          ? `${b.tasks} at once`
          : b.wantedTasks !== null
            ? `${b.tasks} of ${b.wantedTasks} task${b.wantedTasks === 1 ? "" : "s"}`
            : null,
      reason: b.reason,
      since: b.since,
    }));
}

/** The card's view from a budget and the ledger's bookings. Pure; exported for tests. */
export function cloudCapacityView(
  reading: CapacityReading | null,
  bookings: readonly CapacityBooking[] | null,
): CloudCapacityView {
  if (reading === null) return { state: "none" };
  const lighthouseRuns = lighthouseRunsFor(reading.budgetVcpu);
  return {
    state: "ok",
    reading,
    limited:
      reading.source === "quota" &&
      reading.quotaVcpu !== null &&
      reading.quotaVcpu < FULL_SPEED_VCPU,
    lighthouseRuns,
    checkRounds: Math.ceil(MAX_LIGHTHOUSE_TASKS / lighthouseRuns),
    indexTasks: indexTasksAlone(reading.budgetVcpu),
    maxLighthouseTasks: MAX_LIGHTHOUSE_TASKS,
    maxIndexTasks: MAX_JOB_TASKS,
    checkFullSpeedVcpu: CHECK_FULL_SPEED_VCPU,
    fullSpeedVcpu: FULL_SPEED_VCPU,
    jobs: bookings === null ? null : jobLines(bookings),
    consoleUrl: reading.projectId ? quotaConsoleUrl(reading.projectId) : null,
    metric: RUN_CPU_QUOTA_METRIC,
  };
}

/** This install's budget: the quota on Google Cloud, the machine self-hosted, none elsewhere. */
async function installReading(): Promise<CapacityReading | null> {
  const provider = process.env.CAELO_PROVIDER ?? "";
  if (provider === "" || provider === "self-hosted") return inProcessBudget();
  const quota = await readInstallRunQuota();
  return quota === null ? null : quotaBudget(quota);
}

/**
 * Read the card's view; a failed read is shown, not hidden.
 *
 * @param listJobs - the ledger's bookings (`job_capacity.list` as the viewer).
 */
export async function loadCloudCapacity(
  listJobs: () => Promise<readonly CapacityBooking[]>,
  read: () => Promise<CapacityReading | null> = installReading,
): Promise<CloudCapacityView> {
  let reading: CapacityReading | null;
  try {
    reading = await read();
  } catch (e) {
    return {
      state: "error",
      message: `The project's Cloud Run CPU quota could not be read: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const bookings = await listJobs().catch((e: unknown) => {
    console.error(
      "[job-capacity] the card could not read the ledger:",
      e instanceof Error ? e.message : e,
    );
    return null;
  });
  return cloudCapacityView(reading, bookings);
}
