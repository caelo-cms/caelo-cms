// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { RunCapacity } from "@caelo-cms/admin-core";
import { cloudCapacityView, loadCloudCapacity } from "./cloud-capacity-view.js";

/** What admin-core plans for a new project's 20 vCPU (run-capacity.test.ts). */
const NEW_PROJECT: RunCapacity = {
  projectId: "acme-site",
  region: "europe-west1",
  quotaVcpu: 20,
  reservedVcpu: 8,
  lighthouseTasks: 5,
  indexTasks: 1,
  checkFullSpeedVcpu: 40,
  fullSpeedVcpu: 102,
};

describe("cloudCapacityView", () => {
  it("shows a small quota as limited, with the check's rounds and the project's quota page", () => {
    const view = cloudCapacityView(NEW_PROJECT);
    expect(view).toMatchObject({
      state: "ok",
      limited: true,
      checkRounds: 3,
      maxLighthouseTasks: 15,
      maxIndexTasks: 32,
      consoleUrl: "https://console.cloud.google.com/iam-admin/quotas?project=acme-site",
      metric: "run.googleapis.com/cpu_allocation",
    });
  });

  it("shows a quota that runs everything at full width as not limited", () => {
    const view = cloudCapacityView({
      ...NEW_PROJECT,
      quotaVcpu: 3000,
      lighthouseTasks: 15,
      indexTasks: 32,
    });
    expect(view).toMatchObject({ state: "ok", limited: false, checkRounds: 1 });
  });

  it("shows nothing where there is no Cloud Run quota", () => {
    expect(cloudCapacityView(null)).toEqual({ state: "none" });
  });
});

describe("loadCloudCapacity", () => {
  it("shows a failed read with its reason instead of hiding the card", async () => {
    const view = await loadCloudCapacity(async () => {
      throw new Error("HTTP 403 — run `cms-provision upgrade`");
    });
    expect(view).toEqual({
      state: "error",
      message:
        "The project's Cloud Run CPU quota could not be read: HTTP 403 — run `cms-provision upgrade`",
    });
  });
});
