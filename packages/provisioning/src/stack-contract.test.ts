// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { databasePasswordVar } from "@caelo-cms/shared";
import { generateDockerCompose } from "./compose.js";
import {
  adminEnvContract,
  CLI_GENERATED_SECRETS,
  CLOUD_RUN_SLUGS,
  type CloudRunEnvVar,
  cloudRunServicePrefix,
  DATABASE_ROLE_SECRET,
  databaseUrls,
  defaultStagingHost,
  fixedCloudRunServiceName,
  gatewayEnvContract,
  INTERIM_FORWARD_ORIGIN_ENV,
  iamMember,
  MCP_AUTH_PROXY_TRUSTED_PROXY_HOPS,
  mcpAuthProxyEnvContract,
  REMOTE_MCP_MODE,
  RETIRED_IAM_BINDINGS,
  RETIRED_SECRET_FILES,
  RETIRED_SERVICE_ENV,
  runtimeSecretBindings,
  SERVICE_SECRET_ENV,
  SERVICE_SECRET_FILES,
  SERVICE_VPC_EGRESS,
  STACK_IAM_NOT_ENSURED,
  serviceSecrets,
  stackIamInvariants,
} from "./stack-contract.js";

const base = {
  projectId: "acme",
  env: "production",
  domain: "acme.com",
  stagingHost: "staging.acme.com",
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
  CAELO_STAGING_GATE_SECRET: "secret:caelo-production-staging-gate-secret:latest",
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
      MEDIA_ROOT_DIR: "/app/apps/admin/data/media",
      CAELO_MCP_IAP_SERVICE_ACCOUNT: "caelo-mcp@acme.iam.gserviceaccount.com",
      CAELO_MEDIA_BUCKET: "acme-caelo-production-media",
      // #806 — where Settings → MCP → Remote writes the OAuth client.
      CAELO_OPERATOR_OAUTH_CLIENT_STORE:
        "projects/acme/secrets/caelo-production-operator-oauth-client",
      CAELO_OPERATOR_ACCESS_JOB:
        "projects/acme/locations/europe-west1/jobs/caelo-production-operator-access-sync",
      CAELO_UPGRADER_JOB: "projects/acme/locations/europe-west1/jobs/caelo-production-upgrader",
      CAELO_CONVERGE_JOB: "projects/acme/locations/europe-west1/jobs/caelo-production-converge",
      CAELO_AUDIT_JOB: "projects/acme/locations/europe-west1/jobs/caelo-production-audit",
      CAELO_AUDIT_RESULTS_BUCKET: "acme-caelo-production-audit-results",
      CAELO_CAPTURE_BUCKET: "acme-caelo-production-capture",
      CAELO_CAPTURE_JOB: "projects/acme/locations/europe-west1/jobs/caelo-production-capture",
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
      CAELO_MEDIA_BUCKET: "acme-caelo-production-media",
      // #806 — where Settings → MCP → Remote writes the OAuth client.
      CAELO_OPERATOR_OAUTH_CLIENT_STORE:
        "projects/acme/secrets/caelo-production-operator-oauth-client",
      CAELO_OPERATOR_ACCESS_JOB:
        "projects/acme/locations/europe-west1/jobs/caelo-production-operator-access-sync",
      CAELO_UPGRADER_JOB: "projects/acme/locations/europe-west1/jobs/caelo-production-upgrader",
      CAELO_CONVERGE_JOB: "projects/acme/locations/europe-west1/jobs/caelo-production-converge",
      CAELO_AUDIT_JOB: "projects/acme/locations/europe-west1/jobs/caelo-production-audit",
      CAELO_AUDIT_RESULTS_BUCKET: "acme-caelo-production-audit-results",
      CAELO_CAPTURE_BUCKET: "acme-caelo-production-capture",
      CAELO_CAPTURE_JOB: "projects/acme/locations/europe-west1/jobs/caelo-production-capture",
      CAELO_FIREBASE_SITE: "caelo-production-site-abc123",
      CAELO_GATEWAY_SERVICE: "caelo-production-gateway-1a2b3c4",
      CAELO_GATEWAY_REGION: "europe-west1",
      CAELO_STAGING_HOST: "staging.acme.com",
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

  it("carries its one own login and none of the admin's database or app secrets (#635)", () => {
    expect(asRecord(gateway)).toEqual({
      CAELO_PROVIDER: "gcp",
      CAELO_ENV: "production",
      MEDIA_STORAGE_URL: "gs://acme-caelo-production-media",
      // #845 — gcp: the LB appends <client>,<LB IP>.
      CAELO_TRUSTED_PROXY_HOPS: "2",
      PUBLIC_DATABASE_URL: "postgresql://public_role@10.20.0.3:5432/cms_public?sslmode=require",
      PUBLIC_DATABASE_PASSWORD: "secret:caelo-production-public-role-password:latest",
      CAELO_STAGING_GATE_SECRET: "secret:caelo-production-staging-gate-secret:latest",
      // No remote-MCP env: the broker is the MCP-Auth-Proxy's (#1328).
    });
  });

  it("#845 — tells the gateway its provider's proxy hop count", () => {
    // Firebase Hosting / the domain mapping: Cloud Run's front end only.
    const fb = asRecord(gatewayEnvContract({ ...base, provider: "gcp-firebase" }));
    expect(fb.CAELO_TRUSTED_PROXY_HOPS).toBe("1");
    expect(asRecord(gateway).CAELO_TRUSTED_PROXY_HOPS).toBe("2");
  });

  it("#650 — reads the staging host from the database, not its env", () => {
    const fb = asRecord(gatewayEnvContract({ ...base, provider: "gcp-firebase" }));
    expect(fb.CAELO_STAGING_HOST).toBeUndefined();
    expect(fb.CAELO_STAGING_GATE_SECRET).toBe("secret:caelo-production-staging-gate-secret:latest");
  });

  it("#650 — the admin's staging host seed is the install setting, any host", () => {
    const fb = asRecord(
      adminEnvContract({
        ...base,
        stagingHost: "preview.other.de",
        provider: "gcp-firebase",
        firebaseSiteId: "s",
        gatewayService: "g",
      }),
    );
    expect(fb.CAELO_STAGING_HOST).toBe("preview.other.de");
    expect(defaultStagingHost("Acme.com.")).toBe("staging.acme.com");
  });

  it("the gateway's run SA reads no admin-only secret (admin password, KEK, internal, tool approval)", () => {
    expect(serviceSecrets("gateway")).toEqual(["public-role-password", "staging-gate-secret"]);
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
    });
  });

  it("the CLI generates the gateway's role password (never seeded from admin_role's)", () => {
    expect(CLI_GENERATED_SECRETS).toContain("public-role-password");
    // #635 — the former gateway_role is gone; nothing generates its password.
    expect(CLI_GENERATED_SECRETS as readonly string[]).not.toContain("gateway-role-password");
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
        service: "admin",
        secret: "staging-gate-secret",
        stackResource: "staging-gate-secret-binding",
      },
      {
        service: "gateway",
        secret: "public-role-password",
        stackResource: "gateway-public-role-password-binding",
      },
      {
        service: "gateway",
        secret: "staging-gate-secret",
        stackResource: "gateway-staging-gate-secret-binding",
      },
      // #1328 — the broker's seal key (env) and Google sign-in client (a
      // file, which counts like an env secret: the SA reads it).
      {
        service: "mcp-auth-proxy",
        secret: "mcp-oauth-seal-key",
        stackResource: "mcp-auth-proxy-mcp-oauth-seal-key-binding",
      },
      {
        service: "mcp-auth-proxy",
        secret: "operator-oauth-client",
        stackResource: "mcp-auth-proxy-operator-oauth-client-binding",
      },
    ]);
  });

  it("every CLI-generated secret is read by some service", () => {
    for (const s of CLI_GENERATED_SECRETS) {
      expect(CLOUD_RUN_SLUGS.flatMap((slug) => serviceSecrets(slug))).toContain(s);
    }
  });
});

describe("self-hosted compose", () => {
  it("sets CAELO_SITE_URL from the same helper", () => {
    const yaml = generateDockerCompose({
      domain: "acme.com",
      postgresPassword: "p",
      rolePasswords: { admin: "a", public: "b" },
      caeloSecretKek: "k",
      internalSecret: "i".repeat(48),
      diskSize: "10G",
      ports: { http: 80, https: 443 },
      project: "caelo-example-com",
      images: {
        mode: "release" as const,
        admin: `ghcr.io/caelo-cms/admin@sha256:${"a".repeat(64)}`,
        gateway: `ghcr.io/caelo-cms/gateway@sha256:${"b".repeat(64)}`,
      },
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

  it("grants the gateway SA only its own role password, the staging gate key + telemetry roles", () => {
    for (const provider of ["gcp", "gcp-firebase"] as const) {
      const gateway = stackIamInvariants(provider).filter((i) => i.member === "gateway-sa");
      expect(gateway.map((i) => `${i.role} ${JSON.stringify(i.target)}`).sort()).toEqual([
        'roles/logging.logWriter {"kind":"project"}',
        'roles/monitoring.metricWriter {"kind":"project"}',
        'roles/secretmanager.secretAccessor {"kind":"secret","name":"public-role-password"}',
        'roles/secretmanager.secretAccessor {"kind":"secret","name":"staging-gate-secret"}',
      ]);
    }
  });

  it("gcp ensures the telemetry roles too", () => {
    const roles = stackIamInvariants("gcp").map((i) => i.role);
    expect(roles).toContain("roles/logging.logWriter");
    expect(roles).toContain("roles/monitoring.metricWriter");
  });
});

describe("MCP-Auth-Proxy contract (#1328)", () => {
  it("names one service per role; no prefix is a prefix of another", () => {
    for (const provider of ["gcp", "gcp-firebase"] as const) {
      const prefixes = CLOUD_RUN_SLUGS.map((s) => cloudRunServicePrefix(provider, "production", s));
      expect(new Set(prefixes).size).toBe(prefixes.length);
      for (const a of prefixes) {
        for (const b of prefixes) if (a !== b) expect(b.startsWith(a)).toBe(false);
      }
    }
    // E13 (a): on gcp-firebase the proxy keeps the old gateway service.
    expect(cloudRunServicePrefix("gcp-firebase", "production", "mcp-auth-proxy")).toBe(
      "caelo-production-gateway",
    );
    expect(cloudRunServicePrefix("gcp-firebase", "production", "gateway")).toBe(
      "caelo-production-data-gateway",
    );
    expect(cloudRunServicePrefix("gcp", "production", "gateway")).toBe("caelo-production-gateway");
    expect(cloudRunServicePrefix("gcp", "production", "mcp-auth-proxy")).toBe(
      "caelo-production-mcp-auth-proxy",
    );
  });

  it("fixes the names of exactly the services the converge creates", () => {
    expect(fixedCloudRunServiceName("gcp-firebase", "production", "gateway")).toBe(
      "caelo-production-data-gateway",
    );
    expect(fixedCloudRunServiceName("gcp", "production", "mcp-auth-proxy")).toBe(
      "caelo-production-mcp-auth-proxy",
    );
    for (const [provider, slug] of [
      ["gcp-firebase", "admin"],
      ["gcp-firebase", "mcp-auth-proxy"],
      ["gcp", "admin"],
      ["gcp", "gateway"],
    ] as const) {
      expect(fixedCloudRunServiceName(provider, "production", slug)).toBeNull();
    }
  });

  it("gives the proxy no database, site or pool env — only its mode, hops, file and seal key", () => {
    for (const provider of ["gcp", "gcp-firebase"] as const) {
      const env = asRecord(mcpAuthProxyEnvContract({ provider, env: "production" }));
      expect(env).toEqual({
        CAELO_PROVIDER: provider,
        CAELO_REMOTE_MCP: "available",
        CAELO_TRUSTED_PROXY_HOPS: provider === "gcp" ? "2" : "1",
        CAELO_OPERATOR_OAUTH_CLIENT_FILE: "/secrets/operator-oauth-client/client.json",
        CAELO_MCP_OAUTH_SEAL_KEY: "secret:caelo-production-mcp-oauth-seal-key:latest",
      });
      for (const name of Object.keys(env)) expect(name).not.toMatch(/DATABASE|POOL|KEK|STAGING/);
    }
    // Remote MCP needs Google IAP: everywhere else the proxy answers its 404.
    expect(REMOTE_MCP_MODE).toEqual({
      gcp: "available",
      "gcp-firebase": "available",
      "self-hosted": "unavailable",
      aws: "unavailable",
      azure: "unavailable",
    });
    expect(
      asRecord(mcpAuthProxyEnvContract({ provider: "azure", env: "production" })),
    ).toMatchObject({
      CAELO_REMOTE_MCP: "unavailable",
      CAELO_TRUSTED_PROXY_HOPS: String(MCP_AUTH_PROXY_TRUSTED_PROXY_HOPS.azure),
    });
    // The interim forward origin is the stack's / converge's, never the contract's.
    expect(
      mcpAuthProxyEnvContract({ provider: "gcp-firebase", env: "production" }).map((v) => v.name),
    ).not.toContain(INTERIM_FORWARD_ORIGIN_ENV);
  });

  it("the proxy's SA reads exactly its two secrets and holds no other invariant", () => {
    expect(serviceSecrets("mcp-auth-proxy")).toEqual([
      "mcp-oauth-seal-key",
      "operator-oauth-client",
    ]);
    for (const provider of ["gcp", "gcp-firebase"] as const) {
      const proxy = stackIamInvariants(provider).filter((i) => i.member === "mcp-auth-proxy-sa");
      expect(proxy.map((i) => `${i.role} ${JSON.stringify(i.target)}`).sort()).toEqual([
        'roles/secretmanager.secretAccessor {"kind":"secret","name":"mcp-oauth-seal-key"}',
        'roles/secretmanager.secretAccessor {"kind":"secret","name":"operator-oauth-client"}',
      ]);
    }
    expect(SERVICE_VPC_EGRESS["mcp-auth-proxy"]).toBe(false);
    expect(SERVICE_SECRET_FILES["mcp-auth-proxy"]).toHaveLength(1);
    expect(SERVICE_SECRET_FILES.gateway).toEqual([]);
  });

  it("retires the broker's env, file and secret access on the gateway", () => {
    for (const name of [
      "CAELO_OPERATOR_OAUTH_CLIENT_FILE",
      "CAELO_MCP_OAUTH_SEAL_KEY",
      "CAELO_MCP_OAUTH_SEAL_KEY_PREVIOUS",
      "CAELO_MCP_PUBLIC_URL",
      "CAELO_ADMIN_URL",
    ]) {
      expect(RETIRED_SERVICE_ENV.gateway).toContain(name);
    }
    expect(RETIRED_SECRET_FILES.gateway.map((f) => f.secret)).toContain("operator-oauth-client");
    for (const secret of ["mcp-oauth-seal-key", "operator-oauth-client"]) {
      expect(RETIRED_IAM_BINDINGS).toContainEqual(
        expect.objectContaining({ member: "gateway-sa", target: { kind: "secret", name: secret } }),
      );
    }
    // On gcp-firebase the proxy is the old gateway service: its visitor env goes.
    for (const name of [
      "PUBLIC_DATABASE_URL",
      "PUBLIC_DATABASE_PASSWORD",
      "CAELO_STAGING_GATE_SECRET",
    ]) {
      expect(RETIRED_SERVICE_ENV["mcp-auth-proxy"]).toContain(name);
    }
  });

  it("gcp-firebase: the data gateway is the rewrite target, the proxy public", () => {
    const inv = stackIamInvariants("gcp-firebase");
    const on = (service: string) =>
      inv
        .filter((i) => i.target.kind === "run-service" && i.target.service === service)
        .map((i) => `${i.stackResource} ${i.role} ${i.member}`)
        .sort();
    expect(on("gateway")).toEqual([
      "data-gateway-public-invoker roles/run.invoker allUsers",
      "data-gateway-viewer-for-admin-sa roles/run.viewer run-sa",
    ]);
    expect(on("mcp-auth-proxy")).toEqual([
      "gateway-public-invoker roles/run.invoker allUsers",
    ]);
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
    expect(iamMember("mcp-auth-proxy-sa", install)).toBe(
      "serviceAccount:caelo-production-mcp-proxy-sa@acme.iam.gserviceaccount.com",
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
