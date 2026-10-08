// SPDX-License-Identifier: MPL-2.0

/**
 * #553 — the admin memory knob (it runs the Lighthouse quality audit):
 * one default for every adapter, upgrade raises existing installs to it
 * (never lowers), and the cost table prices it.
 */

import { describe, expect, it } from "bun:test";
import { generateDockerCompose } from "./compose.js";
import {
  ADMIN_MEMORY_DEFAULT,
  azureContainerAppResources,
  memoryQuantityMiB,
} from "./stack-contract.js";
import { liveContainerMemory, planAdminMemory, serviceRollArgs } from "./stack-converge.js";
import { estimateGcpCost } from "./wizards/gcp-cost.js";

describe("memoryQuantityMiB", () => {
  it("parses the notations the stacks and gcloud use", () => {
    expect(memoryQuantityMiB("512Mi")).toBe(512);
    expect(memoryQuantityMiB("2Gi")).toBe(2048);
    expect(memoryQuantityMiB("1.5Gi")).toBe(1536);
    expect(memoryQuantityMiB("2G")).toBe(1907);
    expect(memoryQuantityMiB("2 GB")).toBeNull();
    expect(memoryQuantityMiB("lots")).toBeNull();
  });

  it("the default is 2Gi", () => {
    expect(ADMIN_MEMORY_DEFAULT).toBe("2Gi");
  });
});

describe("planAdminMemory (upgrade)", () => {
  it("raises an admin below the default, including Cloud Run's implicit 512Mi", () => {
    expect(planAdminMemory("1Gi")).toEqual({ ok: true, flags: ["--memory=2Gi"], from: "1Gi" });
    expect(planAdminMemory(null)).toEqual({ ok: true, flags: ["--memory=2Gi"], from: null });
  });

  it("never lowers an operator's larger value", () => {
    expect(planAdminMemory("4Gi")).toEqual({ ok: true, flags: [], from: "4Gi" });
    expect(planAdminMemory("2Gi")).toEqual({ ok: true, flags: [], from: "2Gi" });
  });

  it("leaves a value it cannot parse alone, with a reason", () => {
    const r = planAdminMemory("lots");
    expect(r.ok).toBe(false);
  });

  it("reads the live limit from `services describe` JSON", () => {
    const json = JSON.stringify({
      spec: { template: { spec: { containers: [{ resources: { limits: { memory: "1Gi" } } }] } } },
    });
    expect(liveContainerMemory(json)).toBe("1Gi");
    expect(liveContainerMemory(JSON.stringify({ spec: {} }))).toBeNull();
  });

  it("rides the same `services update` as the image roll", () => {
    const args = serviceRollArgs({
      serviceName: "caelo-production-admin",
      region: "europe-west1",
      projectId: "acme",
      imageRef: "img@sha256:abc",
      serviceAccount: "sa@acme.iam.gserviceaccount.com",
      envFlags: ["--update-env-vars=A=b"],
      resourceFlags: ["--memory=2Gi"],
    });
    expect(args).toContain("--memory=2Gi");
    expect(args.indexOf("--memory=2Gi")).toBeLessThan(args.indexOf("--quiet"));
  });
});

describe("self-hosted compose", () => {
  const base = {
    domain: "acme.com",
    postgresPassword: "pw",
    minioRootUser: "caelo",
    minioRootPassword: "pw",
    caeloSecretKek: "0".repeat(64),
    diskSize: "20Gi",
  };

  it("reserves the default admin memory, or the configured one", () => {
    expect(generateDockerCompose(base)).toContain("mem_reservation: 2048m");
    expect(generateDockerCompose({ ...base, adminMemory: "3Gi" })).toContain(
      "mem_reservation: 3072m",
    );
  });

  it("refuses a value that is not a memory quantity", () => {
    expect(() => generateDockerCompose({ ...base, adminMemory: "plenty" })).toThrow(
      /not a memory quantity/,
    );
  });
});

describe("GCP cost table", () => {
  const inputs = {
    cloudSqlTier: "db-f1-micro",
    cloudSqlHa: false,
    adminMinInstances: 0,
    gatewayMinInstances: 0,
    wafAdaptiveProtection: false,
  };

  it("shows the admin memory and a line for the quality checks", () => {
    const { lines } = estimateGcpCost(inputs);
    expect(lines.map((l) => l.name)).toContain("Cloud Run admin (2Gi)");
    expect(lines.some((l) => l.name.startsWith("Quality checks"))).toBe(true);
  });

  it("prices the extra memory of always-on admin instances", () => {
    const admin = (memory: string) =>
      estimateGcpCost({ ...inputs, adminMinInstances: 1, adminMemory: memory }).lines.find((l) =>
        l.name.startsWith("Cloud Run admin"),
      )?.monthlyUsd;
    expect(admin("1Gi")).toBe(16);
    expect(admin("2Gi")).toBe(23);
  });

  it("refuses a memory value provisioning would refuse", () => {
    expect(() => estimateGcpCost({ ...inputs, adminMemory: "lots" })).toThrow("adminMemory");
  });
});

describe("Azure Container Apps sizes", () => {
  it("pairs the memory with its vCPU", () => {
    expect(azureContainerAppResources("2Gi")).toEqual({ cpu: 1, memory: "2.0Gi" });
    expect(azureContainerAppResources("1536Mi")).toEqual({ cpu: 0.75, memory: "1.5Gi" });
  });

  it("refuses sizes Container Apps does not offer", () => {
    for (const q of ["2G", "3.2Gi", "16Gi", "256Mi", "lots"]) {
      expect(() => azureContainerAppResources(q)).toThrow("0.5Gi to 8Gi");
    }
  });
});
