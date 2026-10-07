// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { generateDockerCompose } from "./compose.js";
import {
  adminEnvContract,
  type CloudRunEnvVar,
  gatewayEnvContract,
  iamMember,
  STACK_IAM_NOT_ENSURED,
  stackIamInvariants,
} from "./stack-contract.js";

const base = { projectId: "acme", env: "production", domain: "acme.com", region: "europe-west1" };
const asRecord = (vars: CloudRunEnvVar[]) =>
  Object.fromEntries(vars.map((v) => [v.name, "value" in v ? v.value : "<secret>"]));

describe("adminEnvContract", () => {
  it("gcp: carries the site URL, buckets, generator path and MCP SA", () => {
    expect(asRecord(adminEnvContract({ ...base, provider: "gcp" }))).toEqual({
      CAELO_PROVIDER: "gcp",
      CAELO_ENV: "production",
      MEDIA_STORAGE_URL: "gs://acme-caelo-production-media",
      CAELO_SITE_URL: "https://acme.com",
      CAELO_GENERATOR_CLI: "/app/apps/static-generator/src/cli.ts",
      CAELO_MCP_IAP_SERVICE_ACCOUNT: "caelo-mcp@acme.iam.gserviceaccount.com",
      CAELO_STATIC_BUCKET: "acme-caelo-production-static",
      CAELO_STAGING_BUCKET: "acme-caelo-production-staging",
    });
  });

  it("gcp-firebase: carries the site URL plus the Pulumi-generated Firebase inputs", () => {
    expect(
      asRecord(
        adminEnvContract({
          ...base,
          provider: "gcp-firebase",
          firebaseSiteId: "caelo-production-site-abc123",
          gatewayService: "caelo-production-gateway-1a2b3c4",
        }),
      ),
    ).toEqual({
      CAELO_PROVIDER: "gcp-firebase",
      CAELO_ENV: "production",
      MEDIA_STORAGE_URL: "gs://acme-caelo-production-media",
      CAELO_SITE_URL: "https://acme.com",
      CAELO_GENERATOR_CLI: "/app/apps/static-generator/src/cli.ts",
      CAELO_MCP_IAP_SERVICE_ACCOUNT: "caelo-mcp@acme.iam.gserviceaccount.com",
      CAELO_FIREBASE_SITE: "caelo-production-site-abc123",
      CAELO_GATEWAY_SERVICE: "caelo-production-gateway-1a2b3c4",
      CAELO_GATEWAY_REGION: "europe-west1",
    });
  });

  it("holds no secrets (they stay out of the contract until they move to Secret Manager)", () => {
    const names = adminEnvContract({ ...base, provider: "gcp" }).map((v) => v.name);
    for (const n of names) expect(n).not.toMatch(/DATABASE_URL|KEK|SECRET|PASSWORD|API_KEY/);
  });
});

describe("gatewayEnvContract", () => {
  it("is the shared prefix of the admin's", () => {
    const gateway = gatewayEnvContract({ ...base, provider: "gcp" });
    expect(adminEnvContract({ ...base, provider: "gcp" }).slice(0, gateway.length)).toEqual(
      gateway,
    );
    expect(gateway.map((v) => v.name)).toEqual([
      "CAELO_PROVIDER",
      "CAELO_ENV",
      "MEDIA_STORAGE_URL",
    ]);
  });
});

describe("self-hosted compose", () => {
  it("sets CAELO_SITE_URL from the same helper", () => {
    const yaml = generateDockerCompose({
      domain: "acme.com",
      postgresPassword: "p",
      minioRootUser: "u",
      minioRootPassword: "m",
      caeloSecretKek: "k",
      diskSize: "10G",
    });
    expect(yaml).toContain('CAELO_SITE_URL: "https://acme.com"');
  });
});

describe("stackIamInvariants", () => {
  for (const provider of ["gcp", "gcp-firebase"] as const) {
    it(`${provider}: one invariant per stack resource, none also exempted`, () => {
      const names = stackIamInvariants(provider).map((i) => i.stackResource);
      expect(new Set(names).size).toBe(names.length);
      for (const n of names) expect(STACK_IAM_NOT_ENSURED[provider][n]).toBeUndefined();
    });
  }

  it("gcp-firebase ensures the A5 bindings: run.viewer on the gateway + telemetry roles", () => {
    const inv = stackIamInvariants("gcp-firebase");
    expect(inv).toContainEqual(
      expect.objectContaining({
        role: "roles/run.viewer",
        member: "run-sa",
        target: { kind: "run-service", service: "gateway" },
        onFailure: "abort",
      }),
    );
    for (const role of ["roles/logging.logWriter", "roles/monitoring.metricWriter"]) {
      expect(inv).toContainEqual(
        expect.objectContaining({ role, member: "run-sa", target: { kind: "project" } }),
      );
    }
  });

  it("gcp ensures the telemetry roles too", () => {
    const roles = stackIamInvariants("gcp").map((i) => i.role);
    expect(roles).toContain("roles/logging.logWriter");
    expect(roles).toContain("roles/monitoring.metricWriter");
  });
});

describe("iamMember", () => {
  const install = { projectId: "acme", projectNumber: "123", env: "production" };
  it("resolves every principal to the name the stack gives it", () => {
    expect(iamMember("run-sa", install)).toBe(
      "serviceAccount:caelo-production-run-sa@acme.iam.gserviceaccount.com",
    );
    expect(iamMember("static-publisher-sa", install)).toBe(
      "serviceAccount:caelo-prod-publisher@acme.iam.gserviceaccount.com",
    );
    expect(iamMember("iap-service-agent", install)).toBe(
      "serviceAccount:service-123@gcp-sa-iap.iam.gserviceaccount.com",
    );
    expect(iamMember("allUsers", install)).toBe("allUsers");
  });
});
