// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1776 — the capacity ledger as the launcher and the report
 * endpoint use it: book a job before it starts, start what waited once
 * CPU is free, add helpers to elastic work, and give back what stopped
 * without a word.
 *
 * Admission runs where CPU is freed or wanted, inside a request: after a
 * report that ends a work or changes what it wants (dispatch.ts), and on
 * the scheduler tick (the reporting-job backstop). There is no timer of its
 * own (CLAUDE.md §11.B Tier 5). A start or a helper that fails to launch
 * gives its booking back, and the next admission tries again.
 */

import { execute } from "@caelo-cms/query-api";
import { CAELO_VERSION } from "@caelo-cms/shared";
import { describeError } from "../ai/tools/_describe-error.js";
import { type AdminJobDeps, type KindCapacity, REPORTING_JOB_CTX } from "../reporting-jobs/kind.js";
import type { JobOrder, ReportingJobKind } from "../reporting-jobs/protocol.js";
import type { CapacityReading } from "./budget.js";
import { CAPTURE_VCPU } from "./plan.js";

async function op<T>(deps: AdminJobDeps, name: string, input: unknown): Promise<T> {
  const r = await execute(deps.registry, deps.adapter, REPORTING_JOB_CTX, name, input);
  if (!r.ok) throw new Error(`${name} failed: ${describeError(r.error)}`);
  return r.value as T;
}

/** Record a budget a launcher just read, so the claims of running work use it too. */
export async function recordBudget(deps: AdminJobDeps, reading: CapacityReading): Promise<void> {
  await op(deps, "job_capacity.set_budget", {
    source: reading.source,
    budgetVcpu: reading.budgetVcpu,
    quotaVcpu: reading.quotaVcpu,
    reserveVcpu: reading.reserveVcpu,
    projectId: reading.projectId,
    region: reading.region,
  });
}

/** How a booking went. */
export type Booking =
  | { readonly state: "running"; readonly bookingId: string }
  | { readonly state: "waiting"; readonly bookingId: string; readonly reason: string };

/**
 * Book a piece of work's lead. A job that may wait reads the budget first
 * (`read`), so a raised quota counts from this start on.
 *
 * @throws when the budget cannot be read: the start fails and the
 *   backstop tries again, as for a launch Cloud Run refused.
 */
export async function bookLead(
  deps: AdminJobDeps,
  kind: ReportingJobKind,
  subjectId: string,
  capacity: KindCapacity,
  read: () => Promise<CapacityReading>,
): Promise<Booking> {
  if (capacity.cls !== "immediate" || capacity.auditReserve) await recordBudget(deps, await read());
  const r = await op<{ bookingId: string; state: "running" | "waiting"; reason: string | null }>(
    deps,
    "job_capacity.book",
    {
      kind,
      subjectId,
      role: "lead",
      cls: capacity.cls,
      vcpuPerTask: capacity.vcpuPerTask,
      elastic: capacity.elastic,
      maxTasks: capacity.maxTasks,
      auditReserve: capacity.auditReserve,
    },
  );
  return r.state === "running"
    ? { state: "running", bookingId: r.bookingId }
    : { state: "waiting", bookingId: r.bookingId, reason: r.reason ?? "waits for CPU" };
}

/** Starts one helper execution of a kind's job; resolves with its execution name. */
export type HelperLauncher = (kind: ReportingJobKind, order: JobOrder) => Promise<string>;

/** Starts a waiting lead: the launcher's `startReportingJob` (passed in to keep the modules acyclic). */
export type LeadStarter = (kind: ReportingJobKind, subjectId: string) => Promise<unknown>;

/**
 * Run the admission once: start the leads that waited and now fit, and
 * launch the helpers elastic work was granted. A helper that does not
 * launch gives its booking back.
 *
 * @returns a one-line summary, or undefined when nothing changed.
 */
export async function admitAndLaunch(
  deps: AdminJobDeps,
  startLead: LeadStarter,
  launchHelper: HelperLauncher,
): Promise<string | undefined> {
  const r = await op<{
    leads: { kind: ReportingJobKind; subjectId: string }[];
    helpers: {
      bookingId: string;
      kind: ReportingJobKind;
      subjectId: string;
      attempt: number;
      tasks: number;
      token: string;
    }[];
  }>(deps, "job_capacity.admit", {});
  const parts: string[] = [];
  for (const lead of r.leads) {
    await startLead(lead.kind, lead.subjectId);
    parts.push(`${lead.kind} started after waiting`);
  }
  for (const h of r.helpers) {
    const order: JobOrder = {
      version: CAELO_VERSION,
      kind: h.kind,
      subjectId: h.subjectId,
      attempt: h.attempt,
      token: h.token,
      tasks: h.tasks,
      helper: h.bookingId,
    };
    try {
      const execution = await launchHelper(h.kind, order);
      await op(deps, "job_capacity.record_execution", {
        bookingId: h.bookingId,
        execution: execution.slice(0, 400),
      });
      parts.push(`${h.kind}: ${h.tasks} more task(s)`);
    } catch (e) {
      console.error(
        `[job-capacity] the ${h.kind} helper of ${h.subjectId} did not start (the next admission tries again):`,
        e instanceof Error ? e.message : e,
      );
      await op(deps, "job_capacity.release", {
        bookingId: h.bookingId,
        kind: h.kind,
        subjectId: h.subjectId,
      });
    }
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/**
 * Book one capture (an immediate job: it always starts). Resolves with the
 * release the capture calls when it ends; a capture whose admin died gives
 * its vCPU back when `leaseSeconds` pass (the tick's sweep).
 */
export async function bookCapture(
  deps: AdminJobDeps,
  captureId: string,
  leaseSeconds: number,
): Promise<() => Promise<void>> {
  const r = await op<{ bookingId: string }>(deps, "job_capacity.book", {
    kind: "capture",
    subjectId: captureId,
    role: "capture",
    cls: "immediate",
    vcpuPerTask: CAPTURE_VCPU,
    elastic: false,
    maxTasks: 1,
    auditReserve: false,
    leaseSeconds,
  });
  return async () => {
    await op(deps, "job_capacity.release", {
      bookingId: r.bookingId,
      kind: "capture",
      subjectId: captureId,
    });
  };
}

/** Give back what stopped without a word (the tick). */
export async function sweepCapacity(deps: AdminJobDeps): Promise<number> {
  return (await op<{ released: number }>(deps, "job_capacity.sweep", { limit: 200 })).released;
}
