// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1776 — who runs, who waits, and how wide: the admission rules of
 * the job capacity ledger, as a pure function over the bookings.
 *
 * Every execution Caelo starts books its vCPU first (ledger.ts): every
 * reporting-job kind, every Lighthouse batch, every capture. The budget is
 * what the project's Cloud Run CPU quota leaves after the services (on
 * Google Cloud); inside the admin's process (self-hosted) there is none.
 * Cloud Run does not arbitrate between our jobs and the services that
 * share its quota, so Caelo does it here, and it can: the admin starts
 * every execution itself.
 *
 *   1. Three classes, served in this order and first come first served
 *      inside one (decision 2026-11-27):
 *        immediate   someone waits now: a build's carrier, a capture, a
 *                    quality check (its runner and its Lighthouse runs), a
 *                    site import's crawl. These always start.
 *        stage       a Stage's search index: Publish live waits for it.
 *        background  plugin jobs, scheduled work.
 *      A job that waits holds back every job behind it, so a large one is
 *      never overtaken for good by a stream of small ones.
 *   2. A quality check keeps its Lighthouse share free from its start to its
 *      end ({@link auditReserveVcpu}); each Lighthouse batch then books its
 *      width out of it ({@link lighthouseGrant}).
 *   3. Elastic work (a search index, a plugin job in pieces) runs a lead
 *      task and gets helpers while there is room, up to what it wants; its
 *      tasks claim pieces from the admin. When a job of a higher class needs
 *      the room, helpers stop after their current piece: nothing is lost.
 *   4. Helpers and background jobs leave {@link HEADROOM_VCPU} free for the
 *      immediate jobs that start at any moment (a capture, a carrier).
 *   5. A background job that cannot give CPU back (one that does not work
 *      in pieces) starts only if a quality check still fits after it: its
 *      runner and one Lighthouse run ({@link CHECK_MINIMUM_VCPU}). Room for
 *      a check at full width would keep a large job from ever starting on a
 *      small quota; the check then runs its batch in more rounds.
 *   6. Nothing waits for good: a job that needs more than the whole budget
 *      (a small self-hosted machine, a tiny quota) starts once nothing else
 *      holds any of it.
 */

import { MAX_LIGHTHOUSE_TASKS } from "../reporting-jobs/run-capacity.js";

/** The admission classes, highest first. */
export const CAPACITY_CLASSES = ["immediate", "stage", "background"] as const;
export type CapacityClass = (typeof CAPACITY_CLASSES)[number];

/** What a booking is: a job's own execution, a helper of elastic work, a Lighthouse batch, a capture. */
export const BOOKING_ROLES = ["lead", "helper", "lighthouse", "capture"] as const;
export type BookingRole = (typeof BOOKING_ROLES)[number];

/**
 * vCPU kept out of the budget for the services on Google Cloud: the admin
 * (up to 4 instances of 1 vCPU, pool-budget-stack.ts) and one instance each
 * of the live and the staging gateway. Their scaling is Cloud Run's, so
 * nothing books them; a busier gateway takes room the jobs then give back.
 */
export const SERVICE_RESERVE_VCPU = 6;

/** vCPU helpers and background jobs leave free for an immediate job (a capture, a carrier). */
export const HEADROOM_VCPU = 2;

/** vCPU of a quality check's runner (provisioning reporting-job-catalog.ts). */
export const AUDIT_RUNNER_VCPU = 1;

/** vCPU of one Lighthouse run (provisioning audit-job-setup.ts). */
export const LIGHTHOUSE_RUN_VCPU = 2;

/** vCPU of one search index task (provisioning reporting-job-catalog.ts). */
export const INDEX_TASK_VCPU = 2;

/** vCPU of one capture (provisioning capture-job-setup.ts). */
export const CAPTURE_VCPU = 1;

/** One booking as the planner sees it. */
export interface PlanBooking {
  readonly id: string;
  /** A reporting-job kind, or `capture`. */
  readonly kind: string;
  /** The work it belongs to; a helper or a Lighthouse batch shares its lead's. */
  readonly subjectId: string;
  readonly role: BookingRole;
  readonly cls: CapacityClass;
  readonly state: "waiting" | "running";
  readonly vcpuPerTask: number;
  /** Tasks it holds now (a helper's tasks leave one by one). */
  readonly tasks: number;
  /**
   * A lead of elastic work: the most tasks it would run now, the lead
   * included (its unfinished pieces, capped by what the work may use).
   * One for every other booking.
   */
  readonly wantedTasks: number;
  /** A lead of elastic work: its tasks claim pieces, and helpers may join. */
  readonly elastic: boolean;
  /** A quality check's runner: the Lighthouse share it keeps free. */
  readonly reserveVcpu: number;
  /** When it was booked (ms): the order inside a class. */
  readonly createdAt: number;
}

/** Why a booking waits: what it needs, what is free, and who holds the rest. */
export interface WaitReason {
  readonly needVcpu: number;
  readonly freeVcpu: number;
  readonly budgetVcpu: number;
  /** vCPU per kind holding the budget now (immediate jobs, the index, …). */
  readonly holders: Readonly<Record<string, number>>;
  /** Set when it waits behind an older job of the same or a higher class. */
  readonly behind?: string;
}

/** What the planner decided. */
export interface AdmissionPlan {
  /** Waiting bookings that start now. */
  readonly start: readonly string[];
  /** Bookings that keep waiting, with why. */
  readonly waiting: ReadonlyMap<string, WaitReason>;
  /**
   * Per elastic work (its lead's id): the tasks it may run, the lead
   * included. Below what it runs now, helpers stop after their piece.
   */
  readonly grants: ReadonlyMap<string, number>;
  /** Per elastic work (its lead's id): helper tasks to start now. */
  readonly widen: ReadonlyMap<string, number>;
}

const RANK: Readonly<Record<CapacityClass, number>> = { immediate: 0, stage: 1, background: 2 };

const byPriority = (a: PlanBooking, b: PlanBooking) =>
  RANK[a.cls] - RANK[b.cls] || a.createdAt - b.createdAt || a.id.localeCompare(b.id);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Lighthouse runs a quality check keeps free at a budget: what is left
 * after its runner, one search index task and one capture, up to every run
 * of a batch at once.
 */
export function lighthouseRunsFor(budgetVcpu: number | null): number {
  if (budgetVcpu === null) return MAX_LIGHTHOUSE_TASKS;
  return clamp(
    Math.floor(
      (budgetVcpu - AUDIT_RUNNER_VCPU - INDEX_TASK_VCPU - CAPTURE_VCPU) / LIGHTHOUSE_RUN_VCPU,
    ),
    1,
    MAX_LIGHTHOUSE_TASKS,
  );
}

/** The Lighthouse share a quality check keeps free from its start (rule 2). */
export function auditReserveVcpu(budgetVcpu: number | null): number {
  return lighthouseRunsFor(budgetVcpu) * LIGHTHOUSE_RUN_VCPU;
}

/** vCPU a quality check needs at its narrowest: its runner and one Lighthouse run (rule 5). */
export const CHECK_MINIMUM_VCPU = AUDIT_RUNNER_VCPU + LIGHTHOUSE_RUN_VCPU;

/** The work a booking belongs to. */
export function workKey(b: Pick<PlanBooking, "kind" | "subjectId">): string {
  return `${b.kind}/${b.subjectId}`;
}

/** What the running bookings take, and who holds it. */
function tally(bookings: readonly PlanBooking[]) {
  const running = bookings.filter((b) => b.state === "running");
  const lighthouseInUse = new Map<string, number>();
  for (const b of running)
    if (b.role === "lighthouse")
      lighthouseInUse.set(
        workKey(b),
        (lighthouseInUse.get(workKey(b)) ?? 0) + b.tasks * b.vcpuPerTask,
      );
  let used = 0;
  let reserved = 0;
  const holders: Record<string, number> = {};
  for (const b of running) {
    const v = b.tasks * b.vcpuPerTask;
    used += v;
    holders[b.kind] = (holders[b.kind] ?? 0) + v;
    if (b.reserveVcpu > 0) {
      const left = Math.max(0, b.reserveVcpu - (lighthouseInUse.get(workKey(b)) ?? 0));
      reserved += left;
      holders[b.kind] = (holders[b.kind] ?? 0) + left;
    }
  }
  return { running, used, reserved, holders };
}

/**
 * Decide who starts, who waits, and how wide elastic work runs. Pure.
 *
 * @param budgetVcpu - the vCPU the jobs may use; null for no limit.
 */
export function planAdmission(
  budgetVcpu: number | null,
  bookings: readonly PlanBooking[],
): AdmissionPlan {
  const start: string[] = [];
  const waiting = new Map<string, WaitReason>();
  const grants = new Map<string, number>();
  const widen = new Map<string, number>();
  const tasksOf = (lead: PlanBooking, all: readonly PlanBooking[]) =>
    all
      .filter(
        (b) => b.state === "running" && workKey(b) === workKey(lead) && b.role !== "lighthouse",
      )
      .reduce((n, b) => n + b.tasks, 0);

  if (budgetVcpu === null) {
    for (const b of bookings) if (b.state === "waiting") start.push(b.id);
    const now = bookings.map((b) =>
      b.state === "waiting" ? { ...b, state: "running" as const } : b,
    );
    for (const lead of now.filter((b) => b.role === "lead" && b.elastic)) {
      const current = tasksOf(lead, now);
      grants.set(lead.id, Math.max(current, lead.wantedTasks));
      if (lead.wantedTasks > current) widen.set(lead.id, lead.wantedTasks - current);
    }
    return { start, waiting, grants, widen };
  }

  const t = tally(bookings);
  let free = budgetVcpu - t.used - t.reserved;
  const holders = { ...t.holders };
  const audits = () =>
    bookings.some((b) => b.reserveVcpu > 0 && (b.state === "running" || start.includes(b.id)));

  // Rule 1: immediate jobs always start; the rest in order, a waiting one
  // holding back every job behind it.
  let blocker: PlanBooking | null = null;
  let blockerNeed = 0;
  for (const w of bookings.filter((b) => b.state === "waiting").sort(byPriority)) {
    const cost = w.vcpuPerTask * Math.max(1, w.tasks) + w.reserveVcpu;
    if (w.cls === "immediate") {
      start.push(w.id);
      free -= cost;
      holders[w.kind] = (holders[w.kind] ?? 0) + cost;
      continue;
    }
    const need = Math.min(
      // Rule 6: never more than the whole budget, so it starts on an idle one.
      Math.max(0, budgetVcpu),
      w.vcpuPerTask +
        (w.cls === "background" ? HEADROOM_VCPU : 0) +
        // Rule 5: a background job that cannot give CPU back leaves a check room.
        (w.cls === "background" && !w.elastic && !audits() ? CHECK_MINIMUM_VCPU : 0),
    );
    if (blocker === null && free >= need) {
      start.push(w.id);
      free -= w.vcpuPerTask;
      holders[w.kind] = (holders[w.kind] ?? 0) + w.vcpuPerTask;
      continue;
    }
    if (blocker === null) {
      blocker = w;
      blockerNeed = need;
    }
    waiting.set(w.id, {
      needVcpu: need,
      freeVcpu: Math.max(0, free),
      budgetVcpu,
      holders: { ...holders },
      ...(blocker !== w ? { behind: blocker.kind } : {}),
    });
  }

  // Rule 3: elastic work. First what must be given back, lowest class and
  // newest work first: everything over the budget (an immediate job
  // started, a check keeps its share), and the room a waiting job of a
  // higher class needs. Helpers stop after their current piece, so the
  // room is free minutes later, never at once.
  const after = bookings.map((b) =>
    start.includes(b.id) ? { ...b, state: "running" as const } : b,
  );
  const works = after
    .filter((b) => b.role === "lead" && b.elastic && b.state === "running")
    .sort(byPriority);
  let overBudget = Math.max(0, -free);
  let forBlocker = blocker === null ? 0 : Math.max(0, blockerNeed - free);
  let cutAny = false;
  for (const lead of [...works].reverse()) {
    const current = tasksOf(lead, after);
    grants.set(lead.id, current);
    const yields = blocker !== null && RANK[blocker.cls] < RANK[lead.cls];
    const give = Math.max(overBudget, yields ? forBlocker : 0);
    const helpers = current - 1;
    if (give <= 0 || helpers <= 0) continue;
    const cut = Math.min(helpers, Math.ceil(give / lead.vcpuPerTask));
    grants.set(lead.id, current - cut);
    overBudget -= cut * lead.vcpuPerTask;
    if (yields) forBlocker -= cut * lead.vcpuPerTask;
    cutAny = true;
  }
  // Then, when nothing had to give back, more helpers by priority, out of
  // what is free beyond the headroom and a waiting higher job's room.
  // (Widening only above the headroom and cutting only below zero keeps
  // a short capture from stopping and restarting helpers.)
  if (!cutAny) {
    let pool = free - HEADROOM_VCPU;
    for (const lead of works) {
      const current = tasksOf(lead, after);
      const yields = blocker !== null && RANK[blocker.cls] < RANK[lead.cls];
      const room = yields ? pool - blockerNeed : pool;
      const add = Math.max(
        0,
        Math.min(lead.wantedTasks - current, Math.floor(room / lead.vcpuPerTask)),
      );
      grants.set(lead.id, current + add);
      if (add > 0) {
        widen.set(lead.id, add);
        pool -= add * lead.vcpuPerTask;
      }
    }
  }
  return { start, waiting, grants, widen };
}

/**
 * How many Lighthouse runs a quality check's next batch may run at once:
 * what it wants, up to every run of a batch, out of what the other jobs
 * leave (its own share included). At least one: a check always runs.
 */
export function lighthouseGrant(
  budgetVcpu: number | null,
  bookings: readonly PlanBooking[],
  audit: Pick<PlanBooking, "kind" | "subjectId">,
  wanted: number,
): number {
  const cap = Math.min(wanted, MAX_LIGHTHOUSE_TASKS);
  if (budgetVcpu === null) return Math.max(1, cap);
  const key = workKey(audit);
  const others = bookings.filter((b) => workKey(b) !== key && b.state === "running");
  const t = tally(others);
  const own = bookings
    .filter((b) => workKey(b) === key && b.state === "running" && b.role !== "lighthouse")
    .reduce((n, b) => n + b.tasks * b.vcpuPerTask, 0);
  const room = budgetVcpu - t.used - t.reserved - own;
  return clamp(Math.floor(room / LIGHTHOUSE_RUN_VCPU), 1, Math.max(1, cap));
}

/** Labels of the kinds in a wait reason, for people. */
const KIND_LABELS: Readonly<Record<string, string>> = {
  quality_audit: "the quality check",
  collection_index: "the search index",
  plugin_batch: "plugin jobs",
  site_import: "the site import",
  build: "a build",
  capture: "screenshots",
};

/** A wait reason in operator words. */
export function describeWait(r: WaitReason): string {
  const held = Object.entries(r.holders)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, v]) => `${KIND_LABELS[kind] ?? kind} ${v}`)
    .join(", ");
  const behind = r.behind ? `, behind ${KIND_LABELS[r.behind] ?? r.behind}, which waits too` : "";
  return `waits for ${r.needVcpu} vCPU: ${r.freeVcpu} of ${r.budgetVcpu} vCPU are free${
    held ? ` (in use: ${held})` : ""
  }${behind}`;
}
