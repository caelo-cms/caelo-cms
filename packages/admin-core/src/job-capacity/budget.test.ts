// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { MAX_JOB_TASKS } from "../reporting-jobs/run-capacity.js";
import {
  CHECK_FULL_SPEED_VCPU,
  FULL_SPEED_VCPU,
  indexTasksAlone,
  inProcessBudget,
  quotaBudget,
  quotaForIndexTasks,
} from "./budget.js";
import { lighthouseRunsFor, SERVICE_RESERVE_VCPU } from "./plan.js";

describe("the jobs' budget", () => {
  it("is a quota minus the services, or no limit when Google sets none", () => {
    const q = { projectId: "acme", region: "europe-west1" };
    expect(quotaBudget({ ...q, quotaVcpu: 20 })).toMatchObject({
      source: "quota",
      budgetVcpu: 20 - SERVICE_RESERVE_VCPU,
      quotaVcpu: 20,
    });
    expect(quotaBudget({ ...q, quotaVcpu: 3 }).budgetVcpu).toBe(0);
    expect(quotaBudget({ ...q, quotaVcpu: null }).budgetVcpu).toBeNull();
  });

  it("inside the admin's process sets no limit: its lines run one job of each kind at a time", () => {
    expect(inProcessBudget()).toMatchObject({
      source: "machine",
      budgetVcpu: null,
      quotaVcpu: null,
    });
  });
});

describe("the quotas an Owner asks for", () => {
  it("runs every Lighthouse run of a check at once from 40 vCPU", () => {
    expect(CHECK_FULL_SPEED_VCPU).toBe(40);
    expect(lighthouseRunsFor(CHECK_FULL_SPEED_VCPU - SERVICE_RESERVE_VCPU)).toBe(15);
    expect(lighthouseRunsFor(CHECK_FULL_SPEED_VCPU - SERVICE_RESERVE_VCPU - 1)).toBe(14);
  });

  it("names the quota a wide index needs between checks, and full speed for both", () => {
    expect(quotaForIndexTasks(MAX_JOB_TASKS)).toBe(72);
    expect(indexTasksAlone(quotaForIndexTasks(MAX_JOB_TASKS) - SERVICE_RESERVE_VCPU)).toBe(
      MAX_JOB_TASKS,
    );
    expect(indexTasksAlone(quotaForIndexTasks(12) - SERVICE_RESERVE_VCPU)).toBe(12);
    expect(FULL_SPEED_VCPU).toBe(103);
  });

  it("runs a new project's index on 6 tasks between checks, and one task at least anywhere", () => {
    expect(indexTasksAlone(20 - SERVICE_RESERVE_VCPU)).toBe(6);
    expect(indexTasksAlone(0)).toBe(1);
    expect(indexTasksAlone(null)).toBe(MAX_JOB_TASKS);
  });
});
