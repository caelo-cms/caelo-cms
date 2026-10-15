// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #635 guardrail (c): on EVERY adapter, the API gateway's service
 * env and the secrets it can read hold no cms_admin credential of any role
 * (CLAUDE.md §2: the public side has no path to cms_admin).
 *
 *   gcp, gcp-firebase  the shared env contract (stack-contract.ts) and the
 *                      gateway SA's secret bindings
 *   self-hosted        the generated docker-compose gateway service
 *   azure, aws         the stack programs' gateway container env (read as
 *                      source: they are Pulumi programs, not functions)
 *
 * The gateway itself refuses to boot on such an env
 * (apps/api-gateway `adminDatabaseAccessInEnv`); this catches it at review
 * time, before a release can ship it.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateDockerCompose } from "./compose.js";
import {
  databaseUrls,
  gatewayEnvContract,
  RETIRED_IAM_BINDINGS,
  RETIRED_SERVICE_ENV,
  runtimeSecretBindings,
  SERVICE_SECRET_ENV,
} from "./stack-contract.js";

/** Anything in a gateway env value or name that reaches the authoring database. */
const ADMIN_ACCESS = /cms_admin|admin_role|gateway_role|ADMIN_DATABASE|GATEWAY_DATABASE/;

/** Secrets that unlock a cms_admin login. */
const ADMIN_SECRETS = ["postgres-password", "gateway-role-password"];

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
      rolePasswords: { admin: "adminpw", public: "publicpw" },
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
  });
});

/** The source of a stack program. */
function stack(provider: "aws" | "azure"): string {
  return readFileSync(resolve(import.meta.dir, "..", "stacks", provider, "index.ts"), "utf8");
}

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
});

describe("aws: the stack (#635)", () => {
  it("builds no gateway_role URL and exports no gateway cms_admin DSN", () => {
    const src = stack("aws");
    expect(src).not.toMatch(/gateway_role:\$\{/);
    expect(src).not.toMatch(/gatewayDatabaseUrl/);
  });
});
