// SPDX-License-Identifier: MPL-2.0

/**
 * Upgrade of a v0.10.29 install — database passwords in plain env vars,
 * the gateway holding the KEK, no internal/tool-approval secret — and of a
 * v0.10.35 install — Secret Manager references, but the gateway still on an
 * admin_role pool (#613) — onto the current env contract. A fake Cloud Run applies the
 * `services update` flags with gcloud's semantics (all literal env changes
 * before the secret changes, a type switch inside one kind rejected) and
 * records one revision per update, so the tests can assert that no revision
 * is ever without a var and that the composed database URLs still reach the
 * same database.
 */

import { describe, expect, it } from "bun:test";
import { databaseUrlFromEnv } from "@caelo-cms/shared";
import type { CloudRunSlug } from "./stack-contract.js";
import {
  type LiveEnvValue,
  liveContainerEnv,
  liveEnvHasInlinePassword,
  planContractEnv,
  planEnvUpdate,
  serviceRollArgs,
} from "./stack-converge.js";

const PW = "4f2a9c0d1e2b3a4f5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b";
const HOST = "10.20.0.3";

/** Secret Manager as the fake revisions resolve it. */
const SECRET_VALUES: Record<string, string> = {
  "caelo-production-postgres-password": PW,
  "caelo-production-secret-kek": "k".repeat(64),
  "caelo-production-internal-secret": "i".repeat(64),
  "caelo-production-tool-approval-secret": "t".repeat(64),
  // #613 — the gateway's own role passwords (CLI-generated).
  "caelo-production-public-role-password": "p".repeat(64),
  "caelo-production-gateway-role-password": "g".repeat(64),
};

/** Env vars that would hand the gateway an admin_role credential (apps/api-gateway ADMIN_CREDENTIAL_ENV). */
const ADMIN_CREDENTIAL_ENV = [
  "ADMIN_DATABASE_URL",
  "ADMIN_DATABASE_PASSWORD",
  "PUBLIC_ADMIN_DATABASE_URL",
  "PUBLIC_ADMIN_DATABASE_PASSWORD",
];

/** Split a gcloud list flag value, honouring the `^<delim>^` escape. */
function splitList(value: string): string[] {
  const escaped = value.match(/^\^(.)\^([\s\S]*)$/);
  return escaped ? (escaped[2] as string).split(escaped[1] as string) : value.split(",");
}

/**
 * A Cloud Run service's container env, updated with gcloud's semantics
 * (googlecloudsdk/command_lib/run: EnvVarLiteralChanges applies before
 * SecretEnvVarChanges; each rejects a name already set with the other type).
 */
class FakeService {
  readonly revisions: Map<string, LiveEnvValue>[] = [];
  serviceAccount: string;

  constructor(env: Map<string, LiveEnvValue>, serviceAccount: string) {
    this.revisions.push(env);
    this.serviceAccount = serviceAccount;
  }

  get env(): Map<string, LiveEnvValue> {
    return this.revisions[this.revisions.length - 1] as Map<string, LiveEnvValue>;
  }

  update(args: readonly string[]): void {
    const flag = (name: string) =>
      args
        .filter((a) => a.startsWith(`${name}=`))
        .flatMap((a) => splitList(a.slice(name.length + 1)));
    const env = new Map(this.env);
    // 1. literal changes: removals, then updates
    for (const name of flag("--remove-env-vars")) {
      if (env.get(name)?.kind === "value") env.delete(name);
    }
    for (const pair of flag("--update-env-vars")) {
      const [name, ...rest] = pair.split("=");
      if (env.get(name as string)?.kind === "secret") {
        throw new Error(`Cannot update environment variable [${name}] to string literal`);
      }
      env.set(name as string, { kind: "value", value: rest.join("=") });
    }
    // 2. secret changes: removals, then updates
    for (const name of flag("--remove-secrets")) {
      if (env.get(name)?.kind === "secret") env.delete(name);
    }
    for (const pair of flag("--update-secrets")) {
      const [name, ref] = pair.split("=") as [string, string];
      if (env.get(name)?.kind === "value") {
        throw new Error(`Cannot update environment variable [${name}] to the given type`);
      }
      const [secret, version] = ref.split(":") as [string, string];
      env.set(name, { kind: "secret", secret, version });
    }
    const sa = args.find((a) => a.startsWith("--service-account="));
    if (sa) this.serviceAccount = sa.slice("--service-account=".length);
    this.revisions.push(env);
  }
}

/** The process env a revision's container sees (secrets resolved). */
function containerEnv(env: ReadonlyMap<string, LiveEnvValue>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, v] of env) {
    out[name] = v.kind === "value" ? v.value : (SECRET_VALUES[v.secret] ?? "<missing secret>");
  }
  return out;
}

/** `user:password@host/db?query` of a composed URL. */
function credentials(url: string | undefined): string {
  if (!url) throw new Error("no URL");
  const u = new URL(url);
  return `${u.username}:${u.password}@${u.host}${u.pathname}${u.search}`;
}

/**
 * The gateway's process env after the upgrade: gateway_role on cms_admin and
 * public_role on cms_public, each with its own secret, and no admin_role
 * credential at all (the gateway refuses to boot with one).
 */
function expectGatewayOnItsOwnLogins(env: Record<string, string>): void {
  for (const name of ADMIN_CREDENTIAL_ENV) expect(Object.keys(env)).not.toContain(name);
  expect(Object.values(env).join("\n")).not.toContain(PW);
  expect(credentials(databaseUrlFromEnv(["GATEWAY_DATABASE_URL"], env))).toBe(
    `gateway_role:${"g".repeat(64)}@${HOST}:5432/cms_admin?sslmode=require`,
  );
  expect(credentials(databaseUrlFromEnv(["PUBLIC_DATABASE_URL"], env))).toBe(
    `public_role:${"p".repeat(64)}@${HOST}:5432/cms_public?sslmode=require`,
  );
}

const plainEnv = (entries: Record<string, string>) =>
  Object.entries(entries).map(([name, value]) => ({ name, value }));
const secretRef = (name: string, secret: string) => ({
  name,
  valueFrom: { secretKeyRef: { name: secret, key: "latest" } },
});
const serviceJson = (env: unknown[]) =>
  JSON.stringify({ spec: { template: { spec: { containers: [{ env }] } } } });

/** What `gcloud run services describe` showed on a live v0.10.29 gcp install. */
function v01029Install(scheme: "postgresql" | "postgres") {
  const url = (role: string, db: string) =>
    `${scheme}://${role}:${PW}@${HOST}:5432/${db}?sslmode=require`;
  const common = {
    CAELO_PROVIDER: "gcp",
    CAELO_ENV: "production",
    MEDIA_STORAGE_URL: "gs://acme-caelo-production-media",
  };
  const admin = liveContainerEnv(
    serviceJson([
      ...plainEnv({
        ...common,
        CAELO_SITE_URL: "https://acme.com",
        CAELO_GENERATOR_CLI: "/app/apps/static-generator/src/cli.ts",
        CAELO_MCP_IAP_SERVICE_ACCOUNT: "caelo-mcp@acme.iam.gserviceaccount.com",
        CAELO_STATIC_BUCKET: "acme-caelo-production-static",
        CAELO_STAGING_BUCKET: "acme-caelo-production-staging",
        ADMIN_DATABASE_URL: url("admin_role", "cms_admin"),
      }),
      secretRef("CAELO_SECRET_KEK", "caelo-production-secret-kek"),
      ...plainEnv({ PUBLIC_ADMIN_DATABASE_URL: url("admin_role", "cms_public") }),
    ]),
  );
  const gateway = liveContainerEnv(
    serviceJson([
      ...plainEnv({ ...common, ADMIN_DATABASE_URL: url("admin_role", "cms_admin") }),
      secretRef("CAELO_SECRET_KEK", "caelo-production-secret-kek"),
      ...plainEnv({ PUBLIC_DATABASE_URL: url("public_role", "cms_public") }),
    ]),
  );
  const runSa = "caelo-production-run-sa@acme.iam.gserviceaccount.com";
  return {
    admin: new FakeService(admin, runSa),
    gateway: new FakeService(gateway, runSa),
  };
}

const INSTALL = {
  provider: "gcp" as const,
  projectId: "acme",
  env: "production",
  domain: "acme.com",
  region: "europe-west1",
};
const SERVICE_ACCOUNTS: Record<CloudRunSlug, string> = {
  admin: "caelo-production-run-sa@acme.iam.gserviceaccount.com",
  gateway: "caelo-production-gateway-sa@acme.iam.gserviceaccount.com",
};

/** Plan + apply one upgrade roll on the fake services, as upgradeCommand does. */
function upgrade(services: Record<CloudRunSlug, FakeService>) {
  const plan = planContractEnv(INSTALL, {
    admin: { serviceName: "adm", liveEnv: services.admin.env },
    gateway: { serviceName: "gw", liveEnv: services.gateway.env },
  });
  if (!plan.ok) throw new Error(plan.error);
  for (const slug of ["admin", "gateway"] as const) {
    services[slug].update(
      serviceRollArgs({
        serviceName: slug,
        region: INSTALL.region,
        projectId: INSTALL.projectId,
        imageRef: `${slug}@sha256:new`,
        serviceAccount: SERVICE_ACCOUNTS[slug],
        envFlags: plan.services[slug].flags,
      }),
    );
  }
  return plan;
}

describe.each(["postgresql", "postgres"] as const)(
  "upgrading a v0.10.29 install (%s:// URLs) onto Secret Manager",
  (scheme) => {
    it("moves every database password out of the plain env in one revision per service", () => {
      const services = v01029Install(scheme);
      const plan = upgrade(services);
      for (const slug of ["admin", "gateway"] as const) {
        // One update → exactly one new revision.
        expect(services[slug].revisions).toHaveLength(2);
        for (const [name, v] of services[slug].env) {
          if (v.kind === "value") expect(`${name}=${v.value}`).not.toContain(PW);
        }
        // The flags and what upgrade prints never carry the password either.
        expect(JSON.stringify(plan)).not.toContain(PW);
      }
    });

    it("the admin composes the same credentials; the gateway its own two logins (#613)", () => {
      const services = v01029Install(scheme);
      const before = {
        admin: containerEnv(services.admin.env),
        gateway: containerEnv(services.gateway.env),
      };
      upgrade(services);
      const after = {
        admin: containerEnv(services.admin.env),
        gateway: containerEnv(services.gateway.env),
      };
      for (const vars of [
        ["ADMIN_DATABASE_URL"],
        ["PUBLIC_ADMIN_DATABASE_URL", "PUBLIC_DATABASE_URL"],
      ]) {
        expect(credentials(databaseUrlFromEnv(vars, after.admin))).toBe(
          credentials(databaseUrlFromEnv(vars, before.admin)),
        );
      }
      expectGatewayOnItsOwnLogins(after.gateway);
    });

    it("mounts the internal + tool-approval secrets on the admin and takes the KEK off the gateway", () => {
      const services = v01029Install(scheme);
      upgrade(services);
      const admin = containerEnv(services.admin.env);
      expect(admin.CAELO_INTERNAL_SECRET).toBe("i".repeat(64));
      expect(admin.CAELO_TOOL_APPROVAL_SECRET).toBe("t".repeat(64));
      expect(admin.CAELO_SECRET_KEK).toBe("k".repeat(64));
      const gateway = containerEnv(services.gateway.env);
      expect(Object.keys(gateway)).not.toContain("CAELO_SECRET_KEK");
      expect(Object.keys(gateway)).not.toContain("CAELO_INTERNAL_SECRET");
      expect(services.gateway.serviceAccount).toBe(SERVICE_ACCOUNTS.gateway);
      expect(services.admin.serviceAccount).toBe(SERVICE_ACCOUNTS.admin);
    });

    it("is idempotent: a second upgrade changes no env", () => {
      const services = v01029Install(scheme);
      upgrade(services);
      const again = upgrade(services);
      expect(again.ok && again.services.admin.flags).toEqual([]);
      expect(again.ok && again.services.gateway.flags).toEqual([]);
    });
  },
);

/**
 * What `gcloud run services describe` shows on a v0.10.35 install — after
 * #579 (Secret Manager references, the gateway on its own SA), before #613
 * (the gateway still on an admin_role pool with admin_role's password).
 */
function v01035Install() {
  const url = (role: string, db: string) =>
    `postgresql://${role}@${HOST}:5432/${db}?sslmode=require`;
  const ref = (name: string, secret: string) => ({
    name,
    valueFrom: { secretKeyRef: { name: `caelo-production-${secret}`, key: "latest" } },
  });
  const common = {
    CAELO_PROVIDER: "gcp",
    CAELO_ENV: "production",
    MEDIA_STORAGE_URL: "gs://acme-caelo-production-media",
  };
  const admin = liveContainerEnv(
    serviceJson([
      ...plainEnv({
        ...common,
        ADMIN_DATABASE_URL: url("admin_role", "cms_admin"),
        PUBLIC_ADMIN_DATABASE_URL: url("admin_role", "cms_public"),
      }),
      ref("ADMIN_DATABASE_PASSWORD", "postgres-password"),
      ref("PUBLIC_ADMIN_DATABASE_PASSWORD", "postgres-password"),
      ref("CAELO_SECRET_KEK", "secret-kek"),
      ref("CAELO_INTERNAL_SECRET", "internal-secret"),
      ref("CAELO_TOOL_APPROVAL_SECRET", "tool-approval-secret"),
    ]),
  );
  const gateway = liveContainerEnv(
    serviceJson([
      ...plainEnv({
        ...common,
        PUBLIC_DATABASE_URL: url("public_role", "cms_public"),
        ADMIN_DATABASE_URL: url("admin_role", "cms_admin"),
      }),
      ref("ADMIN_DATABASE_PASSWORD", "postgres-password"),
      ref("PUBLIC_DATABASE_PASSWORD", "postgres-password"),
    ]),
  );
  return {
    admin: new FakeService(admin, SERVICE_ACCOUNTS.admin),
    gateway: new FakeService(gateway, SERVICE_ACCOUNTS.gateway),
  };
}

describe("upgrading a v0.10.35 install: the gateway leaves admin_role (#613)", () => {
  it("drops the admin_role credential and adds the gateway's own logins in one revision", () => {
    const services = v01035Install();
    const plan = upgrade(services);
    expect(services.gateway.revisions).toHaveLength(2);
    expectGatewayOnItsOwnLogins(containerEnv(services.gateway.env));
    // The flags name what changes, never a password.
    expect(JSON.stringify(plan)).not.toContain(PW);
    expect(plan.ok && plan.services.gateway.changes.map((c) => c.name).sort()).toEqual([
      "ADMIN_DATABASE_PASSWORD",
      "ADMIN_DATABASE_URL",
      "GATEWAY_DATABASE_PASSWORD",
      "GATEWAY_DATABASE_URL",
      "PUBLIC_DATABASE_PASSWORD",
    ]);
  });

  it("never leaves a gateway revision without its public pool; the admin keeps its credentials", () => {
    const services = v01035Install();
    const adminBefore = containerEnv(services.admin.env);
    upgrade(services);
    for (const revision of services.gateway.revisions) {
      expect(revision.has("PUBLIC_DATABASE_URL")).toBe(true);
      expect(revision.has("PUBLIC_DATABASE_PASSWORD")).toBe(true);
    }
    const adminAfter = containerEnv(services.admin.env);
    for (const vars of [["ADMIN_DATABASE_URL"], ["PUBLIC_ADMIN_DATABASE_URL"]]) {
      expect(credentials(databaseUrlFromEnv(vars, adminAfter))).toBe(
        credentials(databaseUrlFromEnv(vars, adminBefore)),
      );
    }
  });

  it("is idempotent: a second upgrade changes no env", () => {
    const services = v01035Install();
    upgrade(services);
    const again = upgrade(services);
    expect(again.ok && again.services.gateway.flags).toEqual([]);
    expect(again.ok && again.services.admin.flags).toEqual([]);
  });
});

describe("plain → Secret Manager migration of an existing var", () => {
  it("never leaves a revision without the var", () => {
    // An operator set CAELO_INTERNAL_SECRET by hand as a plain value.
    const svc = new FakeService(
      new Map<string, LiveEnvValue>([["CAELO_INTERNAL_SECRET", { kind: "value", value: "hand" }]]),
      SERVICE_ACCOUNTS.admin,
    );
    const plan = planEnvUpdate(svc.env, [
      {
        name: "CAELO_INTERNAL_SECRET",
        valueSource: {
          secretKeyRef: { secret: "caelo-production-internal-secret", version: "latest" },
        },
      },
    ]);
    if (!plan.ok) throw new Error(plan.error);
    svc.update(plan.flags);
    expect(svc.revisions).toHaveLength(2);
    for (const revision of svc.revisions) expect(revision.has("CAELO_INTERNAL_SECRET")).toBe(true);
    expect(svc.env.get("CAELO_INTERNAL_SECRET")).toEqual({
      kind: "secret",
      secret: "caelo-production-internal-secret",
      version: "latest",
    });
  });

  it("the same switch without the in-update removal is what gcloud rejects", () => {
    const svc = new FakeService(
      new Map<string, LiveEnvValue>([["X", { kind: "value", value: "v" }]]),
      SERVICE_ACCOUNTS.admin,
    );
    expect(() => svc.update(["--update-secrets=X=s:latest"])).toThrow(/different|given type/);
  });
});

describe("liveEnvHasInlinePassword", () => {
  it("flags the v0.10.29 shape and clears once upgraded", () => {
    const services = v01029Install("postgresql");
    expect(liveEnvHasInlinePassword(services.admin.env)).toBe(true);
    expect(liveEnvHasInlinePassword(services.gateway.env)).toBe(true);
    upgrade(services);
    expect(liveEnvHasInlinePassword(services.admin.env)).toBe(false);
    expect(liveEnvHasInlinePassword(services.gateway.env)).toBe(false);
  });
});
