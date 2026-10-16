// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #635 guardrail (c): on EVERY adapter, the API gateway's service
 * env holds no cms_admin credential of any role, AND its identity cannot
 * read a secret that unlocks one (CLAUDE.md §2: the public side has no path
 * to cms_admin). Env strings alone are not enough: a role that may read
 * admin_role's password is a path even when no env var names it.
 *
 *   gcp, gcp-firebase  the env contract (stack-contract.ts), every IAM
 *                      binding the gateway SA gets (contract + stack source)
 *   aws                the gateway's own ECS task role and the secrets its
 *                      policy covers (aws-task-roles.ts + stack source)
 *   azure              the gateway container app's env, and no identity or
 *                      Key Vault access for any container app
 *   self-hosted        the generated compose gateway service: env, secrets,
 *                      mounts
 *
 * The gateway itself refuses to boot on such an env
 * (apps/api-gateway `adminDatabaseAccessInEnv`); this catches it at review
 * time, before a release can ship it.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AWS_SERVICE_SECRETS, secretsReadPolicy } from "./aws-task-roles.js";
import { generateDockerCompose } from "./compose.js";
import {
  databaseUrls,
  gatewayEnvContract,
  RETIRED_IAM_BINDINGS,
  RETIRED_SERVICE_ENV,
  runtimeSecretBindings,
  SERVICE_SECRET_ENV,
  stackIamInvariants,
} from "./stack-contract.js";

/** Anything in a gateway env value or name that reaches the authoring database. */
const ADMIN_ACCESS = /cms_admin|admin_role|gateway_role|ADMIN_DATABASE|GATEWAY_DATABASE/;

/** Secrets that unlock a cms_admin login. */
const ADMIN_SECRETS = ["postgres-password", "gateway-role-password"];

/** The secrets the gateway reads on GCP: its own login and the staging gate key. */
const GCP_GATEWAY_SECRETS = ["public-role-password", "staging-gate-secret"];

/** The source of a stack program. */
function stack(provider: "aws" | "azure" | "gcp" | "gcp-firebase"): string {
  return readFileSync(resolve(import.meta.dir, "..", "stacks", provider, "index.ts"), "utf8");
}

describe("gcp + gcp-firebase: the gateway env contract (#635)", () => {
  const env = gatewayEnvContract({
    provider: "gcp",
    projectId: "acme",
    env: "production",
    domain: "example.com",
    region: "europe-west1",
    stagingHost: "staging.example.com",
    databaseUrls: databaseUrls("10.20.0.3"),
  });

  it("carries no cms_admin URL, role or credential name", () => {
    for (const v of env) {
      expect(v.name).not.toMatch(ADMIN_ACCESS);
      if ("value" in v && typeof v.value === "string") expect(v.value).not.toMatch(ADMIN_ACCESS);
    }
    expect(env.find((v) => v.name === "PUBLIC_DATABASE_URL")).toEqual({
      name: "PUBLIC_DATABASE_URL",
      value: "postgresql://public_role@10.20.0.3:5432/cms_public?sslmode=require",
    });
  });

  it("references no secret that unlocks a cms_admin login", () => {
    for (const secret of Object.values(SERVICE_SECRET_ENV.gateway)) {
      expect(ADMIN_SECRETS).not.toContain(secret);
    }
    const gatewayBindings = runtimeSecretBindings().filter((b) => b.service === "gateway");
    for (const b of gatewayBindings) expect(ADMIN_SECRETS).not.toContain(b.secret);
  });

  for (const provider of ["gcp", "gcp-firebase"] as const) {
    it(`${provider}: the gateway SA's IAM bindings reach no cms_admin secret (review finding)`, () => {
      const gateway = stackIamInvariants(provider).filter((b) => b.member === "gateway-sa");
      for (const b of gateway) {
        if (b.role === "roles/secretmanager.secretAccessor") {
          // Per secret, never project-wide (that would cover every secret).
          expect(b.target.kind).toBe("secret");
          if (b.target.kind === "secret") expect(GCP_GATEWAY_SECRETS).toContain(b.target.name);
        } else {
          expect(["roles/logging.logWriter", "roles/monitoring.metricWriter"]).toContain(b.role);
        }
      }
      // The stack declares no other binding for the gateway SA: the secret
      // bindings go through runtimeSecretBindings, the two telemetry ones
      // name it directly.
      const direct = stack(provider).match(/serviceAccount:\$\{gatewaySa\.email\}/g) ?? [];
      expect(direct).toHaveLength(2);
      expect(stack(provider)).toContain("for (const binding of runtimeSecretBindings())");
    });
  }

  it("upgrade strips the old credentials and the gateway SA's access to them", () => {
    for (const name of [
      "ADMIN_DATABASE_URL",
      "ADMIN_DATABASE_PASSWORD",
      "GATEWAY_DATABASE_URL",
      "GATEWAY_DATABASE_PASSWORD",
    ]) {
      expect(RETIRED_SERVICE_ENV.gateway).toContain(name);
    }
    for (const secret of ADMIN_SECRETS) {
      expect(
        RETIRED_IAM_BINDINGS.some(
          (b) =>
            b.member === "gateway-sa" && b.target.kind === "secret" && b.target.name === secret,
        ),
      ).toBe(true);
    }
  });
});

describe("self-hosted: the generated compose gateway service (#635)", () => {
  it("holds public_role on cms_public and nothing else", () => {
    const out = generateDockerCompose({
      domain: "example.com",
      postgresPassword: "superpw",
      rolePasswords: { admin: "adminpw", public: "publicpw", gateway: "gatewaypw" },
      caeloSecretKek: "0".repeat(64),
      diskSize: "20Gi",
      images: {
        mode: "release" as const,
        admin: `ghcr.io/caelo-cms/admin@sha256:${"a".repeat(64)}`,
        gateway: `ghcr.io/caelo-cms/gateway@sha256:${"b".repeat(64)}`,
      },
      ports: { http: 80, https: 443 },
      project: "caelo-example-com",
    });
    const start = out.indexOf("  caelo-gateway:");
    const end = out.indexOf("\n  caelo-", start + 1);
    const gateway = out.slice(start, end === -1 ? undefined : end);
    expect(gateway).toContain("PUBLIC_DATABASE_URL:");
    expect(gateway).not.toMatch(ADMIN_ACCESS);
    expect(gateway).not.toMatch(/superpw|adminpw|gatewaypw/);
    // No other way in: no Compose secrets, no env file, no mounts (a
    // mounted file is read by no env check), and exactly its own env.
    expect(gateway).not.toMatch(/^ {4}(secrets|env_file|volumes):/m);
    const env = gateway.slice(gateway.indexOf("    environment:"));
    const keys = [...env.matchAll(/^ {6}([A-Z_][A-Z0-9_]*):/gm)].map((m) => m[1]);
    expect(keys.sort()).toEqual(["GATEWAY_PORT", "NODE_ENV", "PUBLIC_DATABASE_URL"]);
    expect(out).not.toMatch(/^secrets:/m);
  });
});

describe("azure: the gateway container app (#635)", () => {
  it("gets PUBLIC_DATABASE_URL only", () => {
    const src = stack("azure");
    const start = src.indexOf('serviceName: "gateway"');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("});", start));
    expect(block).toContain('{ name: "PUBLIC_DATABASE_URL", value: publicDatabaseUrl }');
    expect(block).not.toMatch(/adminDatabase|gatewayDatabase|ADMIN_DATABASE|GATEWAY_DATABASE/);
  });

  it("builds no cms_admin URL for any role but the admin's", () => {
    expect(stack("azure")).not.toMatch(/gateway_role:\$\{/);
  });

  it("gives no container app an identity or Key Vault access (review finding)", () => {
    // The vault uses RBAC authorisation: without a role assignment or a
    // managed identity no container app can read any vault secret, so the
    // gateway's only credential is the public_role URL in its env.
    const src = stack("azure");
    expect(src).toContain("enableRbacAuthorization: true");
    expect(src).not.toMatch(/RoleAssignment|accessPolicies|identity\s*:|keyVaultUrl|secretRef/);
  });
});

describe("aws: the stack (#635)", () => {
  it("builds no gateway_role URL and exports no gateway cms_admin DSN", () => {
    const src = stack("aws");
    expect(src).not.toMatch(/gateway_role:\$\{/);
    expect(src).not.toMatch(/gatewayDatabaseUrl/);
  });

  it("the gateway's task role reads only the public_role password (review finding)", () => {
    expect(AWS_SERVICE_SECRETS.gateway).toEqual(["public-role-password"]);
    for (const secret of ADMIN_SECRETS) expect(AWS_SERVICE_SECRETS.gateway).not.toContain(secret);
  });

  it("each service gets its own task role whose policy is built from that table", () => {
    const src = stack("aws");
    expect(src).toContain('gateway: taskRole("gateway")');
    expect(src).toContain('admin: taskRole("admin")');
    // One RolePolicy, inside taskRole, scoped by AWS_SERVICE_SECRETS[service]:
    // no policy anywhere lists secret ARNs by hand.
    expect(src.match(/new aws\.iam\.RolePolicy\(/g)).toHaveLength(1);
    expect(src).toContain(".all(AWS_SERVICE_SECRETS[service].map((name) => secretArns[name]))");
    expect(src).not.toMatch(/GetSecretValue/);
  });

  it("secretsReadPolicy grants GetSecretValue on exactly the given ARNs", () => {
    expect(JSON.parse(secretsReadPolicy(["arn:a", "arn:b"]))).toEqual({
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: ["arn:a", "arn:b"] },
      ],
    });
    expect(() => secretsReadPolicy([])).toThrow();
  });
});
