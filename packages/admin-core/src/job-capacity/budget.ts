// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1776 — the vCPU the jobs of an install may use (the ledger's
 * budget), and the quotas an Owner asks Google for to make them faster.
 *
 *   Google Cloud  the project's Cloud Run CPU quota in the region, minus
 *                 what the services keep ({@link SERVICE_RESERVE_VCPU}).
 *   self-hosted   the machine's cores minus one for the admin: the jobs run
 *                 inside the admin's process there, on the same machine.
 */

import { availableParallelism } from "node:os";
import {
  MAX_JOB_TASKS,
  MAX_LIGHTHOUSE_TASKS,
  type QuotaReading,
} from "../reporting-jobs/run-capacity.js";
import {
  AUDIT_RUNNER_VCPU,
  CAPTURE_VCPU,
  HEADROOM_VCPU,
  INDEX_TASK_VCPU,
  LIGHTHOUSE_RUN_VCPU,
  SERVICE_RESERVE_VCPU,
} from "./plan.js";

/** What a launcher read: the budget and where it comes from. */
export interface CapacityReading {
  readonly source: "quota" | "machine";
  /** The vCPU the jobs may use; null when Google sets no limit. */
  readonly budgetVcpu: number | null;
  /** The project's quota (Google Cloud); null for none, or on a machine. */
  readonly quotaVcpu: number | null;
  /** What stays out of the budget: the services, or the admin's own core. */
  readonly reserveVcpu: number;
  readonly projectId: string | null;
  readonly region: string | null;
}

/** The budget a Cloud Run quota leaves the jobs. */
export function quotaBudget(q: QuotaReading): CapacityReading {
  return {
    source: "quota",
    budgetVcpu: q.quotaVcpu === null ? null : Math.max(0, q.quotaVcpu - SERVICE_RESERVE_VCPU),
    quotaVcpu: q.quotaVcpu,
    reserveVcpu: SERVICE_RESERVE_VCPU,
    projectId: q.projectId,
    region: q.region,
  };
}

/** The budget of a self-hosted machine: its cores, one left to the admin. */
export function machineBudget(cores: number = availableParallelism()): CapacityReading {
  return {
    source: "machine",
    budgetVcpu: Math.max(1, cores - 1),
    quotaVcpu: null,
    reserveVcpu: 1,
    projectId: null,
    region: null,
  };
}

/**
 * The quota at which a search index runs on `tasks` between quality
 * checks: what an Owner asks for to make a large build faster.
 */
export function quotaForIndexTasks(tasks: number): number {
  return SERVICE_RESERVE_VCPU + HEADROOM_VCPU + tasks * INDEX_TASK_VCPU;
}

/** The quota at which every Lighthouse run of a check runs at once, next to one index task. */
export const CHECK_FULL_SPEED_VCPU =
  SERVICE_RESERVE_VCPU +
  AUDIT_RUNNER_VCPU +
  MAX_LIGHTHOUSE_TASKS * LIGHTHOUSE_RUN_VCPU +
  INDEX_TASK_VCPU +
  CAPTURE_VCPU;

/** The quota at which a check at full speed and the widest index build run together. */
export const FULL_SPEED_VCPU =
  SERVICE_RESERVE_VCPU +
  AUDIT_RUNNER_VCPU +
  MAX_LIGHTHOUSE_TASKS * LIGHTHOUSE_RUN_VCPU +
  HEADROOM_VCPU +
  MAX_JOB_TASKS * INDEX_TASK_VCPU;

/** How wide a search index runs with no check beside it, at a budget. */
export function indexTasksAlone(budgetVcpu: number | null): number {
  if (budgetVcpu === null) return MAX_JOB_TASKS;
  return Math.min(
    MAX_JOB_TASKS,
    Math.max(1, Math.floor((budgetVcpu - HEADROOM_VCPU) / INDEX_TASK_VCPU)),
  );
}
