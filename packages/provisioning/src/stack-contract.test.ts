// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { databasePasswordVar } from "@caelo-cms/shared";
import { generateDockerCompose } from "./compose.js";
import {
  adminEnvContract,
  CLI_GENERATED_SECRETS,
  type CloudRunEnvVar,
  DATABASE_ROLE_SECRET,
  databaseUrls,
  gatewayEnvContract,
  iamMember,
  RETIRED_IAM_BINDINGS,
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
  it("builds password-less URLs for the four role/database pairs", () => {
    expect(databaseUrls("10.20.0.3")).toEqual({
      admin: "postgresql://admin_role@10.20.0.3:5432/cms_admin?sslmode=require",
      publicAdmin: "postgresql://admin_role@10.20.0.3:5432/cms_public?sslmode=require",
      public: "postgresql://public_role@10.20.0.3:5432/cms_public?sslmode=require",
      gateway: "postgresql://gateway_role@10.20.0.3:5432/cms_admin?sslmode=require",
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
      MEDIA_ROOT_DIR: "/app/apps/admin/data/media",
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
      MEDIA_ROOT_DIR: "/app/apps/admin/data/media",
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

  it("carries its two own logins and none of the admin's database or app secrets", () => {
    expect(asRecord(gateway)).toEqual({
      CAELO_PROVIDER: "gcp",
      CAELO_ENV: "production",
      MEDIA_STORAGE_URL: "gs://acme-caelo-production-media",
      PUBLIC_DATABASE_URL: "postgresql://public_role@10.20.0.3:5432/cms_public?sslmode=require",
      GATEWAY_DATABASE_URL: "postgresql://gateway_role@10.20.0.3:5432/cms_admin?sslmode=require",
      PUBLIC_DATABASE_PASSWORD: "secret:caelo-production-public-role-password:latest",
      GATEWAY_DATABASE_PASSWORD: "secret:caelo-production-gateway-role-password:latest",
    });
  });

  it("the gateway's run SA reads no admin-only secret (admin password, KEK, internal, tool approval)", () => {
    expect(serviceSecrets("gateway")).toEqual(["gateway-role-password", "public-role-password"]);
    for (const v of gateway) {
      expect(v.name).not.toMatch(/KEK|INTERNAL|TOOL_APPROVAL|PUBLIC_ADMIN/);
    }
  });

  it("retires the KEK the older stacks gave it", () => {
    expect(RETIRED_SERVICE_ENV.gateway).toContain("CAELO_SECRET_KEK");
    expect(gateway.map((v) => v.name)).not.toContain("CAELO_SECRET_KEK");
  });

  // Issue #613 closed the CLAUDE.md §2 gap #579 documented here ("still
  // carries the admin_role credential the gateway boots with"): the gateway
  // gets no admin_role URL, password or secret, and upgrade removes the
  // ones older installs carry.
  it("holds no admin_role credential, and upgrade retires the old ones (CLAUDE.md §2, #613)", () => {
    const names = gateway.map((v) => v.name);
    expect(names).not.toContain("ADMIN_DATABASE_URL");
    expect(names).not.toContain("ADMIN_DATABASE_PASSWORD");
    for (const v of gateway) {
      if ("value" in v && v.value.includes("://")) {
        expect(new URL(v.value).username).not.toBe("admin_role");
      }
    }
    expect(serviceSecrets("gateway")).not.toContain(DATABASE_ROLE_SECRET.admin_role);
    expect(RETIRED_SERVICE_ENV.gateway).toEqual(
      expect.arrayContaining(["ADMIN_DATABASE_URL", "ADMIN_DATABASE_PASSWORD"]),
    );
  });
});

describe("database role secrets (#613)", () => {
  it("gives every role its own password secret", () => {
    const secrets = Object.values(DATABASE_ROLE_SECRET);
    expect(new Set(secrets).size).toBe(secrets.length);
    expect(DATABASE_ROLE_SECRET).toEqual({
      admin_role: "postgres-password",
      public_role: "public-role-password",
      gateway_role: "gateway-role-password",
    });
  });

  it("the CLI generates the gateway's role passwords (never seeded from admin_role's)", () => {
    expect(CLI_GENERATED_SECRETS).toEqual(
      expect.arrayContaining(["public-role-password", "gateway-role-password"]),
    );
  });

  it("retires the gateway SA's read access to admin_role's password", () => {
    expect(RETIRED_IAM_BINDINGS).toContainEqual(
      expect.objectContaining({
        role: "roles/secretmanager.secretAccessor",
        member: "gateway-sa",
        target: { kind: "secret", name: "postgres-password" },
      }),
    );
    for (const provider of ["gcp", "gcp-firebase"] as const) {
      // Never both ensured and retired.
      for (const r of RETIRED_IAM_BINDINGS) {
        expect(
          stackIamInvariants(provider).some(
            (i) =>
              i.role === r.role &&
              i.member === r.member &&
              JSON.stringify(i.target) === JSON.stringify(r.target),
          ),
        ).toBe(false);
      }
    }
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
        secret: "gateway-role-password",
        stackResource: "gateway-gateway-role-password-binding",
      },
      {
        service: "gateway",
        secret: "public-role-password",
        stackResource: "gateway-public-role-password-binding",
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
      rolePasswords: { admin: "a", public: "b", gateway: "g" },
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

  it("grants the gateway SA only its two role passwords + telemetry roles", () => {
    for (const provider of ["gcp", "gcp-firebase"] as const) {
      const gateway = stackIamInvariants(provider).filter((i) => i.member === "gateway-sa");
      expect(gateway.map((i) => `${i.role} ${JSON.stringify(i.target)}`).sort()).toEqual([
        'roles/logging.logWriter {"kind":"project"}',
        'roles/monitoring.metricWriter {"kind":"project"}',
        'roles/secretmanager.secretAccessor {"kind":"secret","name":"gateway-role-password"}',
        'roles/secretmanager.secretAccessor {"kind":"secret","name":"public-role-password"}',
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
