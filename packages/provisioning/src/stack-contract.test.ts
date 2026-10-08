// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { databasePasswordVar } from "@caelo-cms/shared";
import { generateDockerCompose } from "./compose.js";
import {
  adminEnvContract,
  CLI_GENERATED_SECRETS,
  type CloudRunEnvVar,
  databaseUrls,
  gatewayEnvContract,
  iamMember,
  RETIRED_SERVICE_ENV,
  runtimeSecretBindings,
  SERVICE_SECRET_ENV,
  STACK_IAM_NOT_ENSURED,
  serviceSecrets,
  stackIamInvariants,
} from "./stack-contract.js";

const base = {
  projectId: "acme",
  env: "production",
  domain: "acme.com",
  region: "europe-west1",
  databaseUrls: databaseUrls("10.20.0.3"),
};
const asRecord = (vars: CloudRunEnvVar[]) =>
  Object.fromEntries(
    vars.map((v) => [
      v.name,
      "value" in v
        ? v.value
        : `secret:${v.valueSource.secretKeyRef.secret}:${v.valueSource.secretKeyRef.version}`,
    ]),
  );

const ADMIN_SECRETS = {
  ADMIN_DATABASE_PASSWORD: "secret:caelo-production-postgres-password:latest",
  PUBLIC_ADMIN_DATABASE_PASSWORD: "secret:caelo-production-postgres-password:latest",
  CAELO_SECRET_KEK: "secret:caelo-production-secret-kek:latest",
  CAELO_INTERNAL_SECRET: "secret:caelo-production-internal-secret:latest",
  CAELO_TOOL_APPROVAL_SECRET: "secret:caelo-production-tool-approval-secret:latest",
};

describe("databaseUrls", () => {
  it("builds password-less URLs for the three role/database pairs", () => {
    expect(databaseUrls("10.20.0.3")).toEqual({
      admin: "postgresql://admin_role@10.20.0.3:5432/cms_admin?sslmode=require",
      publicAdmin: "postgresql://admin_role@10.20.0.3:5432/cms_public?sslmode=require",
      public: "postgresql://public_role@10.20.0.3:5432/cms_public?sslmode=require",
    });
  });
});

describe("adminEnvContract", () => {
  it("gcp: carries the database URLs, site URL, buckets, generator path, MCP SA and secrets", () => {
    expect(asRecord(adminEnvContract({ ...base, provider: "gcp" }))).toEqual({
      CAELO_PROVIDER: "gcp",
      CAELO_ENV: "production",
      MEDIA_STORAGE_URL: "gs://acme-caelo-production-media",
      ADMIN_DATABASE_URL: "postgresql://admin_role@10.20.0.3:5432/cms_admin?sslmode=require",
      PUBLIC_ADMIN_DATABASE_URL:
        "postgresql://admin_role@10.20.0.3:5432/cms_public?sslmode=require",
      CAELO_SITE_URL: "https://acme.com",
      CAELO_GENERATOR_CLI: "/app/apps/static-generator/src/cli.ts",
      CAELO_MCP_IAP_SERVICE_ACCOUNT: "caelo-mcp@acme.iam.gserviceaccount.com",
      CAELO_OPERATOR_ACCESS_JOB:
        "projects/acme/locations/europe-west1/jobs/caelo-production-operator-access-sync",
      CAELO_STATIC_BUCKET: "acme-caelo-production-static",
      CAELO_STAGING_BUCKET: "acme-caelo-production-staging",
      ...ADMIN_SECRETS,
    });
  });

  it("gcp-firebase: adds the Pulumi-generated Firebase inputs", () => {
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
      ADMIN_DATABASE_URL: "postgresql://admin_role@10.20.0.3:5432/cms_admin?sslmode=require",
      PUBLIC_ADMIN_DATABASE_URL:
        "postgresql://admin_role@10.20.0.3:5432/cms_public?sslmode=require",
      CAELO_SITE_URL: "https://acme.com",
      CAELO_GENERATOR_CLI: "/app/apps/static-generator/src/cli.ts",
      CAELO_MCP_IAP_SERVICE_ACCOUNT: "caelo-mcp@acme.iam.gserviceaccount.com",
      CAELO_OPERATOR_ACCESS_JOB:
        "projects/acme/locations/europe-west1/jobs/caelo-production-operator-access-sync",
      CAELO_FIREBASE_SITE: "caelo-production-site-abc123",
      CAELO_GATEWAY_SERVICE: "caelo-production-gateway-1a2b3c4",
      CAELO_GATEWAY_REGION: "europe-west1",
      ...ADMIN_SECRETS,
    });
  });
});

describe.each([
  ["admin", adminEnvContract({ ...base, provider: "gcp" })],
  ["gateway", gatewayEnvContract({ ...base, provider: "gcp" })],
] as const)("%s env contract", (service, vars) => {
  it("carries no secret value in a plain var (C1: run.services.get exposes plain vars)", () => {
    for (const v of vars) {
      if (!("value" in v)) continue;
      expect(v.name).not.toMatch(/PASSWORD|SECRET|KEK|API_KEY|TOKEN/);
      // A URL var never carries a password inline.
      if (v.value.includes("://")) expect(new URL(v.value).password).toBe("");
    }
  });

  it("references exactly the secrets SERVICE_SECRET_ENV gives the service", () => {
    const refs = Object.fromEntries(
      vars.flatMap((v) =>
        "valueSource" in v ? [[v.name, v.valueSource.secretKeyRef.secret] as const] : [],
      ),
    );
    expect(refs).toEqual(
      Object.fromEntries(
        Object.entries(SERVICE_SECRET_ENV[service]).map(([name, secret]) => [
          name,
          `caelo-production-${secret}`,
        ]),
      ),
    );
  });

  it("pairs every password-less database URL with a password var the apps compose it from", () => {
    const names = vars.map((v) => v.name);
    for (const url of names.filter((n) => n.endsWith("DATABASE_URL"))) {
      expect(names).toContain(databasePasswordVar(url));
    }
  });
});

describe("gatewayEnvContract", () => {
  const gateway = gatewayEnvContract({ ...base, provider: "gcp" });

  it("carries the public_role URL and none of the admin's cms_public or app secrets", () => {
    expect(asRecord(gateway)).toEqual({
      CAELO_PROVIDER: "gcp",
      CAELO_ENV: "production",
      MEDIA_STORAGE_URL: "gs://acme-caelo-production-media",
      PUBLIC_DATABASE_URL: "postgresql://public_role@10.20.0.3:5432/cms_public?sslmode=require",
      ADMIN_DATABASE_URL: "postgresql://admin_role@10.20.0.3:5432/cms_admin?sslmode=require",
      PUBLIC_DATABASE_PASSWORD: "secret:caelo-production-postgres-password:latest",
      ADMIN_DATABASE_PASSWORD: "secret:caelo-production-postgres-password:latest",
    });
  });

  it("the gateway's run SA reads no admin-only secret (KEK, internal, tool approval)", () => {
    expect(serviceSecrets("gateway")).toEqual(["postgres-password"]);
    for (const v of gateway) {
      expect(v.name).not.toMatch(/KEK|INTERNAL|TOOL_APPROVAL|PUBLIC_ADMIN/);
    }
  });

  it("retires the KEK the older stacks gave it", () => {
    expect(RETIRED_SERVICE_ENV.gateway).toContain("CAELO_SECRET_KEK");
    expect(gateway.map((v) => v.name)).not.toContain("CAELO_SECRET_KEK");
  });

  // Documents the known gap (stack-contract.ts SERVICE_SECRET_ENV.gateway):
  // the gateway boots an admin_role pool, so it still gets that credential —
  // as a Secret Manager reference. When the gateway stops needing admin_role,
  // flip this to `not.toContain` and drop the two vars from the contract.
  it("still carries the admin_role credential the gateway boots with (CLAUDE.md §2 gap)", () => {
    const names = gateway.map((v) => v.name);
    expect(names).toContain("ADMIN_DATABASE_URL");
    expect(names).toContain("ADMIN_DATABASE_PASSWORD");
  });
});

describe("runtime secrets", () => {
  it("binds each service's SA to exactly the secrets its env reads", () => {
    expect(runtimeSecretBindings()).toEqual([
      { service: "admin", secret: "postgres-password", stackResource: "postgres-password-binding" },
      { service: "admin", secret: "secret-kek", stackResource: "secret-kek-binding" },
      { service: "admin", secret: "internal-secret", stackResource: "internal-secret-binding" },
      {
        service: "admin",
        secret: "tool-approval-secret",
        stackResource: "tool-approval-secret-binding",
      },
      {
        service: "gateway",
        secret: "postgres-password",
        stackResource: "gateway-postgres-password-binding",
      },
    ]);
  });

  it("every CLI-generated secret is read by some service", () => {
    for (const s of CLI_GENERATED_SECRETS) {
      expect([...serviceSecrets("admin"), ...serviceSecrets("gateway")]).toContain(s);
    }
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

  it("grants the gateway SA only its secret + telemetry roles", () => {
    for (const provider of ["gcp", "gcp-firebase"] as const) {
      const gateway = stackIamInvariants(provider).filter((i) => i.member === "gateway-sa");
      expect(gateway.map((i) => `${i.role} ${JSON.stringify(i.target)}`).sort()).toEqual([
        'roles/logging.logWriter {"kind":"project"}',
        'roles/monitoring.metricWriter {"kind":"project"}',
        'roles/secretmanager.secretAccessor {"kind":"secret","name":"postgres-password"}',
      ]);
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
    expect(iamMember("gateway-sa", install)).toBe(
      "serviceAccount:caelo-production-gateway-sa@acme.iam.gserviceaccount.com",
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
