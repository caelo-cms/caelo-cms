// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { type CapacityBooking, machineBudget, quotaBudget } from "@caelo-cms/admin-core";
import { cloudCapacityView, jobLines, loadCloudCapacity } from "./cloud-capacity-view.js";

/** A new project's 20 vCPU. */
const NEW_PROJECT = quotaBudget({ projectId: "acme-site", region: "europe-west1", quotaVcpu: 20 });

const booking = (over: Partial<CapacityBooking>): CapacityBooking => ({
  kind: "collection_index",
  subjectId: "00000000-0000-4000-8000-000000001776",
  role: "lead",
  cls: "stage",
  state: "running",
  vcpu: 2,
  tasks: 1,
  wantedTasks: null,
  reserveVcpu: 0,
  reason: null,
  since: "2026-11-27T10:00:00.000Z",
  ...over,
});

describe("cloudCapacityView", () => {
  it("shows a small quota as limited: the check's rounds, the index between checks, the quota page", () => {
    expect(cloudCapacityView(NEW_PROJECT, [])).toMatchObject({
      state: "ok",
      limited: true,
      lighthouseRuns: 5,
      checkRounds: 3,
      indexTasks: 6,
      maxLighthouseTasks: 15,
      maxIndexTasks: 32,
      checkFullSpeedVcpu: 40,
      fullSpeedVcpu: 103,
      jobs: [],
      consoleUrl: "https://console.cloud.google.com/iam-admin/quotas?project=acme-site",
      metric: "run.googleapis.com/cpu_allocation",
    });
  });

  it("shows a quota that runs everything at full width as not limited", () => {
    const view = cloudCapacityView(
      quotaBudget({ projectId: "acme-site", region: "europe-west1", quotaVcpu: 3000 }),
      [],
    );
    expect(view).toMatchObject({ state: "ok", limited: false, checkRounds: 1, indexTasks: 32 });
  });

  it("shows a self-hosted machine's cores, never as a quota to raise", () => {
    expect(cloudCapacityView(machineBudget(4), [])).toMatchObject({
      state: "ok",
      limited: false,
      consoleUrl: null,
      lighthouseRuns: 1,
    });
  });

  it("shows nothing where the provider has no job budget", () => {
    expect(cloudCapacityView(null, [])).toEqual({ state: "none" });
  });
});

describe("jobLines", () => {
  it("lists what runs first, with its width, then what waits and why", () => {
    expect(
      jobLines([
        booking({
          kind: "plugin_batch",
          cls: "background",
          state: "waiting",
          vcpu: 0,
          reason: "waits for 4 vCPU: 2 of 14 vCPU are free (in use: the search index 12)",
        }),
        booking({ tasks: 6, wantedTasks: 32, vcpu: 12 }),
        booking({
          kind: "quality_audit",
          cls: "immediate",
          vcpu: 1,
          reserveVcpu: 10,
          since: "2026-11-27T09:59:00.000Z",
        }),
        booking({ kind: "capture", role: "capture", cls: "immediate", vcpu: 2, tasks: 2 }),
      ]).map((l) => [l.label, l.state, l.vcpu, l.width, l.reason]),
    ).toEqual([
      ["Quality check", "running", 11, null, null],
      ["Search index", "running", 12, "6 of 32 tasks", null],
      ["Screenshots", "running", 2, "2 at once", null],
      [
        "Plugin job",
        "waiting",
        0,
        null,
        "waits for 4 vCPU: 2 of 14 vCPU are free (in use: the search index 12)",
      ],
    ]);
  });
});

describe("a line's identity", () => {
  it("is its work, so two jobs started in one admission never share a key", () => {
    const lines = jobLines([
      booking({ kind: "plugin_batch", subjectId: "00000000-0000-4000-8000-00000000000a" }),
      booking({ kind: "plugin_batch", subjectId: "00000000-0000-4000-8000-00000000000b" }),
    ]);
    expect(new Set(lines.map((l) => l.key)).size).toBe(2);
  });
});

describe("loadCloudCapacity", () => {
  it("shows a failed quota read with its reason instead of hiding the card", async () => {
    const view = await loadCloudCapacity(
      async () => [],
      async () => {
        throw new Error("HTTP 403 — run `cms-provision upgrade`");
      },
    );
    expect(view).toEqual({
      state: "error",
      message:
        "The project's Cloud Run CPU quota could not be read: HTTP 403 — run `cms-provision upgrade`",
    });
  });

  it("still shows the budget when the ledger cannot be read", async () => {
    const view = await loadCloudCapacity(
      async () => {
        throw new Error("pool busy");
      },
      async () => NEW_PROJECT,
    );
    expect(view).toMatchObject({ state: "ok", jobs: null });
  });
});
