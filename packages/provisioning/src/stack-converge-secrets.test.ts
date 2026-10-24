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
import type { GcloudResult } from "./gcloud.js";
import {
  type CloudRunSlug,
  OPERATOR_OAUTH_CLIENT_FILE,
  RETIRED_SECRET_FILES,
} from "./stack-contract.js";
import {
  findVolumesWithMissingSecrets,
  type LiveEnvValue,
  liveContainerEnv,
  liveEnvHasInlinePassword,
  planContractEnv,
  planEnvUpdate,
  planSecretFiles,
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

/** Env vars that would hand the gateway a cms_admin credential (a subset of what apps/api-gateway adminDatabaseAccessInEnv refuses). */
const ADMIN_CREDENTIAL_ENV = [
  "ADMIN_DATABASE_URL",
  "ADMIN_DATABASE_PASSWORD",
  "PUBLIC_ADMIN_DATABASE_URL",
  "PUBLIC_ADMIN_DATABASE_PASSWORD",
  "GATEWAY_DATABASE_URL",
  "GATEWAY_DATABASE_PASSWORD",
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
 * The gateway's process env after the upgrade: public_role on cms_public
 * with its own secret, and no cms_admin credential of any role at all
 * (#613, #635 — the gateway refuses to boot with one).
 */
function expectGatewayOnItsOwnLogins(env: Record<string, string>): void {
  for (const name of ADMIN_CREDENTIAL_ENV) expect(Object.keys(env)).not.toContain(name);
  expect(Object.values(env).join("\n")).not.toContain(PW);
  expect(Object.values(env).join("\n")).not.toContain("g".repeat(64));
  expect(Object.values(env).join("\n")).not.toContain("cms_admin");
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
  stagingHost: "staging.acme.com",
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
  it("drops the admin_role credential and adds the gateway's own login in one revision", () => {
    const services = v01035Install();
    const plan = upgrade(services);
    expect(services.gateway.revisions).toHaveLength(2);
    expectGatewayOnItsOwnLogins(containerEnv(services.gateway.env));
    // The flags name what changes, never a password.
    expect(JSON.stringify(plan)).not.toContain(PW);
    expect(plan.ok && plan.services.gateway.changes.map((c) => c.name).sort()).toEqual([
      "ADMIN_DATABASE_PASSWORD",
      "ADMIN_DATABASE_URL",
      // #806 — the remote-MCP broker's seal key and (#914) the Google
      // sign-in client file path.
      "CAELO_MCP_OAUTH_SEAL_KEY",
      "CAELO_OPERATOR_OAUTH_CLIENT_FILE",
      // #650 — the staging gate key arrives in the same roll.
      "CAELO_STAGING_GATE_SECRET",
      // #845 — and which forwarded address is the visitor.
      "CAELO_TRUSTED_PROXY_HOPS",
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

/**
 * A v0.10.50 install (#613, before #635): the gateway on gateway_role's
 * cms_admin pool next to public_role's.
 */
function v01050Install() {
  const services = v01035Install();
  upgrade(services);
  const env = new Map(services.gateway.env);
  env.set("GATEWAY_DATABASE_URL", {
    kind: "value",
    value: `postgresql://gateway_role@${HOST}:5432/cms_admin?sslmode=require`,
  });
  env.set("GATEWAY_DATABASE_PASSWORD", {
    kind: "secret",
    secret: "caelo-production-gateway-role-password",
    version: "latest",
  });
  services.gateway = new FakeService(env, SERVICE_ACCOUNTS.gateway);
  return services;
}

describe("upgrading a v0.10.50 install: the gateway leaves cms_admin entirely (#635)", () => {
  it("removes the gateway_role login in one revision and keeps the public pool", () => {
    const services = v01050Install();
    const plan = upgrade(services);
    expect(plan.ok && plan.services.gateway.changes.map((c) => c.name).sort()).toEqual([
      "GATEWAY_DATABASE_PASSWORD",
      "GATEWAY_DATABASE_URL",
    ]);
    expectGatewayOnItsOwnLogins(containerEnv(services.gateway.env));
    for (const revision of services.gateway.revisions) {
      expect(revision.has("PUBLIC_DATABASE_URL")).toBe(true);
    }
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

describe("retiring a secret file removes its volume too (#954)", () => {
  // The shape searchviu's gateway was left in: gcloud names a volume it
  // mints for `--update-secrets` after the secret plus a random suffix.
  const RETIRED_VOLUME = "caelo-production-mcp-oauth-client-mac-won";
  const OPERATOR_VOLUME = "caelo-production-operator-oauth-client-puw-tuq";
  const operatorVolume = {
    name: OPERATOR_VOLUME,
    secret: {
      secretName: "caelo-production-operator-oauth-client",
      items: [{ key: "latest", path: "client.json" }],
    },
  };
  const retiredVolume = {
    name: RETIRED_VOLUME,
    secret: {
      secretName: "projects/42/secrets/caelo-production-mcp-oauth-client",
      items: [{ key: "latest", path: "client.json" }],
    },
  };
  const plan = (live: Parameters<typeof planSecretFiles>[0]) =>
    planSecretFiles(live, [OPERATOR_OAUTH_CLIENT_FILE], "production", RETIRED_SECRET_FILES.gateway);

  it("a retired mount: removes the file, the mount and the volume behind it in the roll", () => {
    const r = plan({
      executionEnvironment: null,
      volumes: [retiredVolume],
      mounts: [{ name: RETIRED_VOLUME, mountPath: "/secrets/mcp-oauth-client" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flags).toContain("--remove-secrets=/secrets/mcp-oauth-client/client.json");
    expect(r.flags).toContain(`--remove-volume=${RETIRED_VOLUME}`);
    expect(r.flags).toContain("--remove-volume-mount=/secrets/mcp-oauth-client");
    expect(r.changes.some((c) => c.startsWith(`volume ${RETIRED_VOLUME}: removed`))).toBe(true);
  });

  it("an orphaned retired volume (no mount, the searchviu state): removes it and says so", () => {
    const r = plan({
      executionEnvironment: null,
      volumes: [retiredVolume, operatorVolume],
      mounts: [{ name: OPERATOR_VOLUME, mountPath: "/secrets/operator-oauth-client" }],
    });
    expect(r).toEqual({
      ok: true,
      flags: [`--remove-volume=${RETIRED_VOLUME}`],
      changes: [
        `volume ${RETIRED_VOLUME}: removed (the Google sign-in client is mounted from operator-oauth-client now (#914); nothing mounts it)`,
      ],
    });
  });

  it("a converged service plans nothing", () => {
    const r = plan({
      executionEnvironment: null,
      volumes: [operatorVolume],
      mounts: [{ name: OPERATOR_VOLUME, mountPath: "/secrets/operator-oauth-client" }],
    });
    expect(r).toEqual({ ok: true, flags: [], changes: [] });
  });

  it("refuses a volume of the retired secret mounted somewhere else instead of pulling it", () => {
    const r = plan({
      executionEnvironment: null,
      volumes: [retiredVolume, operatorVolume],
      mounts: [
        { name: OPERATOR_VOLUME, mountPath: "/secrets/operator-oauth-client" },
        { name: RETIRED_VOLUME, mountPath: "/elsewhere" },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain(`--remove-volume=${RETIRED_VOLUME}`);
  });

  describe("preflight: a volume pointing at a deleted secret", () => {
    const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
    const missing: GcloudResult = {
      ok: false,
      stdout: "",
      stderr:
        "ERROR: (gcloud.secrets.describe) NOT_FOUND: Secret [projects/42/secrets/x] not found",
      exitCode: 1,
    };
    const where = {
      serviceName: "caelo-production-gateway-532b35d",
      projectId: "acme",
      region: "europe-west1",
    };
    const live = {
      executionEnvironment: null,
      volumes: [retiredVolume, operatorVolume],
      mounts: [{ name: OPERATOR_VOLUME, mountPath: "/secrets/operator-oauth-client" }],
    };
    const gcloud = (gone: string) => {
      const calls: string[] = [];
      const run = async (args: string[]) => {
        calls.push(args.join(" "));
        return args[2] === gone ? missing : ok("name");
      };
      return { run, calls };
    };

    it("names the volume and the exact fix", async () => {
      const g = gcloud("caelo-production-mcp-oauth-client");
      const problems = await findVolumesWithMissingSecrets(live, where, [], g.run);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`volume "${RETIRED_VOLUME}" (not mounted)`);
      expect(problems[0]).toContain("caelo-production-mcp-oauth-client, which no longer exists");
      expect(problems[0]).toContain(
        `gcloud run services update caelo-production-gateway-532b35d --region=europe-west1 --project=acme --remove-volume=${RETIRED_VOLUME}`,
      );
    });

    it("skips a volume the roll removes anyway", async () => {
      const g = gcloud("caelo-production-mcp-oauth-client");
      expect(await findVolumesWithMissingSecrets(live, where, [RETIRED_VOLUME], g.run)).toEqual([]);
      expect(g.calls.some((c) => c.includes("mcp-oauth-client"))).toBe(false);
    });

    it("a mounted volume's fix removes the mount too", async () => {
      const g = gcloud("caelo-production-operator-oauth-client");
      const [problem] = await findVolumesWithMissingSecrets(live, where, [RETIRED_VOLUME], g.run);
      expect(problem).toContain(
        `--remove-volume-mount=/secrets/operator-oauth-client --remove-volume=${OPERATOR_VOLUME}`,
      );
    });
  });
});
