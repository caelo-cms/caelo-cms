// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  auditReserveVcpu,
  CHECK_MINIMUM_VCPU,
  describeWait,
  HEADROOM_VCPU,
  lighthouseGrant,
  lighthouseRunsFor,
  type PlanBooking,
  planAdmission,
  SERVICE_RESERVE_VCPU,
} from "./plan.js";

let seq = 0;
function booking(over: Partial<PlanBooking> & Pick<PlanBooking, "kind" | "cls">): PlanBooking {
  seq += 1;
  return {
    id: `b${seq}`,
    subjectId: `s-${over.kind}`,
    role: "lead",
    state: "running",
    vcpuPerTask: 1,
    tasks: 1,
    wantedTasks: 1,
    elastic: false,
    reserveVcpu: 0,
    createdAt: seq,
    ...over,
  };
}

/** A new project: 20 vCPU quota. */
const B20 = 20 - SERVICE_RESERVE_VCPU;

const audit = (over: Partial<PlanBooking> = {}) =>
  booking({ kind: "quality_audit", cls: "immediate", reserveVcpu: auditReserveVcpu(B20), ...over });
const index = (over: Partial<PlanBooking> = {}) =>
  booking({
    kind: "collection_index",
    cls: "stage",
    vcpuPerTask: 2,
    elastic: true,
    wantedTasks: 32,
    ...over,
  });
const helper = (lead: PlanBooking, tasks: number) =>
  booking({
    kind: lead.kind,
    subjectId: lead.subjectId,
    cls: lead.cls,
    role: "helper",
    vcpuPerTask: lead.vcpuPerTask,
    tasks,
  });

describe("the quality check's share", () => {
  it("keeps 5 Lighthouse runs free on a new project and all 15 on a large quota", () => {
    expect(B20).toBe(14);
    expect(lighthouseRunsFor(B20)).toBe(5);
    expect(auditReserveVcpu(B20)).toBe(10);
    expect(lighthouseRunsFor(100 - SERVICE_RESERVE_VCPU)).toBe(15);
    expect(lighthouseRunsFor(null)).toBe(15);
    // A tiny budget still gets one run: a check always runs.
    expect(lighthouseRunsFor(3)).toBe(1);
  });
});

describe("a Stage on a 20-vCPU project", () => {
  it("starts the check and one index task together", () => {
    const a = audit({ state: "waiting" });
    const i = index({ state: "waiting" });
    const plan = planAdmission(B20, [a, i]);
    expect(plan.start).toEqual([a.id, i.id]);
    expect(plan.grants.get(i.id)).toBe(1);
    expect(plan.widen.size).toBe(0);
  });

  it("widens the index to 6 tasks once the check is over", () => {
    const i = index();
    const plan = planAdmission(B20, [i]);
    // 14 − 2 (the lead) − 2 (headroom) = 10: five helpers.
    expect(plan.widen.get(i.id)).toBe(5);
    expect(plan.grants.get(i.id)).toBe(6);
  });

  it("the next Stage's check makes the helpers stop after their piece", () => {
    const i = index();
    const h = helper(i, 5);
    const a = audit({ state: "waiting" });
    const plan = planAdmission(B20, [i, h, a]);
    expect(plan.start).toEqual([a.id]);
    // 12 (index) + 11 (check) = 23 of 14: the index goes back to its lead.
    expect(plan.grants.get(i.id)).toBe(1);
    expect(plan.widen.size).toBe(0);
  });

  it("does not widen into the share of a check that runs", () => {
    const a = audit();
    const i = index();
    const plan = planAdmission(B20, [a, i]);
    expect(plan.grants.get(i.id)).toBe(1);
    expect(plan.widen.size).toBe(0);
  });

  it("a short capture next to a wide index stops nobody", () => {
    const i = index();
    const h = helper(i, 5);
    const c = booking({ kind: "capture", cls: "immediate", role: "capture", state: "waiting" });
    const plan = planAdmission(B20, [i, h, c]);
    expect(plan.start).toEqual([c.id]);
    expect(plan.grants.get(i.id)).toBe(6);
  });
});

describe("admission order", () => {
  it("starts immediate jobs even over the budget", () => {
    const i = index();
    const h = helper(i, 5);
    const build = booking({ kind: "build", cls: "immediate", state: "waiting" });
    const c1 = booking({ kind: "capture", cls: "immediate", role: "capture", state: "waiting" });
    const c2 = booking({ kind: "capture", cls: "immediate", role: "capture", state: "waiting" });
    const plan = planAdmission(B20, [i, h, build, c1, c2]);
    expect(plan.start).toEqual([build.id, c1.id, c2.id]);
    // 12 + 3 = 15 of 14: one helper stops.
    expect(plan.grants.get(i.id)).toBe(5);
  });

  it("a waiting job holds back every job behind it, and says so", () => {
    const i = index();
    const h = helper(i, 5);
    const batch = booking({ kind: "plugin_batch", cls: "background", state: "waiting" });
    const later = booking({
      kind: "plugin_batch",
      cls: "background",
      state: "waiting",
      subjectId: "s2",
    });
    const plan = planAdmission(B20, [i, h, batch, later]);
    expect(plan.start).toEqual([]);
    const first = plan.waiting.get(batch.id);
    expect(first?.behind).toBeUndefined();
    expect(first?.needVcpu).toBe(1 + HEADROOM_VCPU + CHECK_MINIMUM_VCPU);
    expect(plan.waiting.get(later.id)?.behind).toBe("plugin_batch");
    // The index is of a higher class: it does not yield to a plugin job.
    expect(plan.grants.get(i.id)).toBe(6);
  });

  it("elastic background work yields to a waiting search index", () => {
    const p = booking({
      kind: "plugin_batch",
      cls: "background",
      vcpuPerTask: 2,
      elastic: true,
      wantedTasks: 8,
    });
    const i = index({ state: "waiting" });
    // 14 − 12 = 2 free, the index lead needs 2: it starts, nothing is cut.
    const fits = planAdmission(B20, [p, helper(p, 5), i]);
    expect(fits.start).toEqual([i.id]);
    expect(fits.grants.get(p.id)).toBe(6);
    // 14 − 14 = 0 free: the index waits, and one plugin helper stops for it.
    const full = planAdmission(B20, [p, helper(p, 6), i]);
    expect(full.start).toEqual([]);
    expect(full.waiting.has(i.id)).toBe(true);
    expect(full.grants.get(p.id)).toBe(6);
  });

  it("a rigid background job starts only with room for a check left", () => {
    const big = booking({
      kind: "plugin_batch",
      cls: "background",
      vcpuPerTask: 4,
      state: "waiting",
    });
    // 14 free ≥ 4 + 2 + 3: it starts.
    expect(planAdmission(B20, [big]).start).toEqual([big.id]);
    const busy = booking({ kind: "site_import", cls: "immediate", vcpuPerTask: 6 });
    // 8 free < 9: it waits.
    const plan = planAdmission(B20, [busy, big]);
    expect(plan.start).toEqual([]);
    expect(plan.waiting.get(big.id)?.needVcpu).toBe(9);
  });

  it("without a limit everything starts and elastic work runs as wide as it wants", () => {
    const i = index({ state: "waiting" });
    const batch = booking({ kind: "plugin_batch", cls: "background", state: "waiting" });
    const plan = planAdmission(null, [i, batch]);
    expect(plan.start).toEqual([i.id, batch.id]);
    expect(plan.widen.get(i.id)).toBe(31);
  });
});

describe("a Lighthouse batch's width", () => {
  it("gets its share next to a narrow index, more when nothing else runs", () => {
    const a = audit();
    const i = index();
    expect(lighthouseGrant(B20, [a, i], a, 15)).toBe(5);
    expect(lighthouseGrant(B20, [a], a, 15)).toBe(6);
    expect(lighthouseGrant(null, [a], a, 15)).toBe(15);
  });

  it("runs at least one run while helpers still finish their pieces", () => {
    const a = audit();
    const i = index();
    expect(lighthouseGrant(B20, [a, i, helper(i, 5)], a, 15)).toBe(1);
  });

  it("never asks for more than the batch has", () => {
    const a = audit();
    expect(lighthouseGrant(B20, [a], a, 3)).toBe(3);
  });
});

describe("a wait in operator words", () => {
  it("names what it needs, what is free and who holds the rest", () => {
    expect(
      describeWait({
        needVcpu: 6,
        freeVcpu: 2,
        budgetVcpu: 14,
        holders: { collection_index: 12, capture: 0 },
      }),
    ).toBe("waits for 6 vCPU: 2 of 14 vCPU are free (in use: the search index 12)");
  });
});
