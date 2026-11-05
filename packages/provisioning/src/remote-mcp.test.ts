// SPDX-License-Identifier: MPL-2.0

/**
 * #806 — remote MCP's provisioning: the contract pieces (identity env,
 * secrets, IAM), the gateway's secret file + timeout planning, and the CLI
 * steps (identity resolution, LB path rules, Cloud Armor rule).
 */

import { describe, expect, it } from "bun:test";
import { GCP_GATEWAY_PATHS, GCP_MCP_AUTH_PROXY_PATHS } from "@caelo-cms/shared";
import type { GcloudResult } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import {
  checkRemoteMcpIdentityEnv,
  ensureMcpArmorRule,
  ensureMcpAuthProxyBackend,
  ensureRemoteMcpEdge,
  findRemoteMcpTarget,
  type LiveUrlMap,
  planUrlMapPaths,
  type RemoteMcpTarget,
  resolveGoogleOrgDomain,
  resolveRemoteMcpIdentity,
  resolveStackRemoteMcpIdentity,
  retireGatewayMcpArmorRule,
} from "./remote-mcp.js";
import {
  GENERAL_RATE_LIMIT_PRIORITY,
  isMcpArmorRule,
  MCP_ARMOR_PATH_PATTERN,
  MCP_ARMOR_RULE,
  mcpArmorRuleArgs,
  mcpArmorRuleFlags,
  OWASP_RULE_PRIORITIES,
} from "./remote-mcp-edge.js";
import { initialSecretValue } from "./runtime-secrets.js";
import {
  CLI_GENERATED_SECRETS,
  GATEWAY_TRUSTED_PROXY_HOPS,
  GENERATED_SECRET_FORMAT,
  MCP_AUTH_PROXY_TIMEOUT_SECONDS,
  MCP_AUTH_PROXY_TRUSTED_PROXY_HOPS,
  OPERATOR_OAUTH_CLIENT_FILE,
  REMOTE_MCP_ENV,
  RETIRED_RUNTIME_SECRETS,
  RETIRED_SECRET_FILES,
  RETIRED_SERVICE_ENV,
  remoteMcpIdentity,
  remoteMcpIdentityEnv,
  SERVICE_SECRET_FILES,
  secretFileVolumesTemplate,
  stackIamInvariants,
} from "./stack-contract.js";
import { deleteRetiredSecrets, planRequestTimeout, planSecretFiles } from "./stack-converge.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "" }) as GcloudResult;
const fail = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr }) as GcloudResult;

/** A gcloud fake answering by the longest matching command prefix. */
function fakeGcloud(answers: Record<string, GcloudResult>) {
  const calls: string[] = [];
  const run: GcloudRunner = async (args) => {
    const line = args.join(" ");
    calls.push(line);
    const key = Object.keys(answers)
      .filter((k) => line.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    return key ? (answers[key] as GcloudResult) : fail(`unexpected: ${line}`);
  };
  return { run, calls };
}

describe("remote-MCP identity (contract)", () => {
  it("gcp: the site's own host, admin.<domain>, the LB backend's audience", () => {
    expect(
      remoteMcpIdentity({
        provider: "gcp",
        domain: "acme.com",
        projectNumber: "42",
        adminBackendServiceId: "123456789",
      }),
    ).toEqual({
      adminUrl: "https://admin.acme.com",
      mcpPublicUrl: "https://acme.com",
      iapAudience: "/projects/42/global/backendServices/123456789",
    });
  });

  it("gcp-firebase: the MCP-Auth-Proxy's (the old gateway service, E13 a) and admin's Cloud Run URLs, the service's audience", () => {
    expect(
      remoteMcpIdentity({
        provider: "gcp-firebase",
        projectNumber: "42",
        region: "europe-west1",
        adminServiceName: "caelo-production-admin-aaa",
        adminServiceUrl: "https://caelo-production-admin-aaa-xyz.a.run.app/",
        mcpAuthProxyServiceUrl: "https://caelo-production-gateway-bbb-xyz.a.run.app",
      }),
    ).toEqual({
      adminUrl: "https://caelo-production-admin-aaa-xyz.a.run.app",
      mcpPublicUrl: "https://caelo-production-gateway-bbb-xyz.a.run.app",
      iapAudience: "/projects/42/locations/europe-west1/services/caelo-production-admin-aaa",
    });
  });

  it("puts the broker on the path its CAELO_TRUSTED_PROXY_HOPS describes (per-client rate limits)", () => {
    // The broker's per-address buckets read the client from X-Forwarded-For
    // with the deployment's hop count (api-gateway client-ip.ts). gcp: the
    // broker answers on the site host, through the LB (client + LB = 2).
    // gcp-firebase: on the gateway's own run.app URL, never through the
    // Firebase Hosting rewrite, so Cloud Run's front end appends the real
    // client (1). A broker URL on the Hosting path would key every client by
    // a Google proxy address that changes per request
    // (docs/dev/firebase-hosting-behaviour.md).
    expect(MCP_AUTH_PROXY_TRUSTED_PROXY_HOPS.gcp).toBe(2);
    expect(GATEWAY_TRUSTED_PROXY_HOPS.gcp).toBe(2);
    expect(
      remoteMcpIdentity({
        provider: "gcp",
        domain: "acme.com",
        projectNumber: "42",
        adminBackendServiceId: "1",
      }).mcpPublicUrl,
    ).toBe("https://acme.com");
    expect(MCP_AUTH_PROXY_TRUSTED_PROXY_HOPS["gcp-firebase"]).toBe(1);
    const firebase = remoteMcpIdentity({
      provider: "gcp-firebase",
      projectNumber: "42",
      region: "europe-west1",
      adminServiceName: "a",
      adminServiceUrl: "https://a-xyz.a.run.app",
      mcpAuthProxyServiceUrl: "https://g-xyz.a.run.app",
    });
    expect(new URL(firebase.mcpPublicUrl).hostname.endsWith(".run.app")).toBe(true);
  });

  it("gives the admin the audience, public URL and its own URL, the proxy the admin + public URL, the gateway nothing", () => {
    const env = remoteMcpIdentityEnv({ adminUrl: "A", mcpPublicUrl: "P", iapAudience: "AUD" });
    expect(env.admin).toEqual([
      { name: REMOTE_MCP_ENV.iapAudience, value: "AUD" },
      { name: REMOTE_MCP_ENV.mcpPublicUrl, value: "P" },
      // #914 — Google sign-in's self-check opens the admin signed out.
      { name: REMOTE_MCP_ENV.adminUrl, value: "A" },
    ]);
    expect(env["mcp-auth-proxy"]).toEqual([
      { name: REMOTE_MCP_ENV.adminUrl, value: "A" },
      { name: REMOTE_MCP_ENV.mcpPublicUrl, value: "P" },
    ]);
    // #1328 — the visitor gateway holds none of remote MCP.
    expect(env.gateway).toEqual([]);
    expect(REMOTE_MCP_ENV).toEqual({
      adminUrl: "CAELO_ADMIN_URL",
      mcpPublicUrl: "CAELO_MCP_PUBLIC_URL",
      iapAudience: "CAELO_IAP_AUDIENCE",
      googleOrgDomain: "CAELO_GOOGLE_ORG_DOMAIN",
    });
  });

  it("#914 — gives the admin the organisation domain only when it was read", () => {
    const known = remoteMcpIdentityEnv({
      adminUrl: "A",
      mcpPublicUrl: "P",
      iapAudience: "AUD",
      googleOrgDomain: "acme.com",
    });
    expect(known.admin).toContainEqual({ name: "CAELO_GOOGLE_ORG_DOMAIN", value: "acme.com" });
    expect(known["mcp-auth-proxy"].map((e) => e.name)).not.toContain("CAELO_GOOGLE_ORG_DOMAIN");
    const unknown = remoteMcpIdentityEnv({ adminUrl: "A", mcpPublicUrl: "P", iapAudience: "AUD" });
    expect(unknown.admin.map((e) => e.name)).not.toContain("CAELO_GOOGLE_ORG_DOMAIN");
  });
});

describe("remote-MCP secrets + IAM (contract)", () => {
  it("names a first-value format for every CLI-generated secret", () => {
    expect(Object.keys(GENERATED_SECRET_FORMAT).sort()).toEqual([...CLI_GENERATED_SECRETS].sort());
  });

  it("starts the OAuth client as the {} placeholder and the seal key as 32 random bytes", () => {
    expect(initialSecretValue("operator-oauth-client")).toBe("{}");
    const a = initialSecretValue("mcp-oauth-seal-key");
    expect(Buffer.from(a, "base64")).toHaveLength(32);
    expect(initialSecretValue("mcp-oauth-seal-key")).not.toBe(a);
    expect(initialSecretValue("internal-secret", () => "hex")).toBe("hex");
  });

  it("lets the admin add versions to the OAuth client secret only — never read, never another secret", () => {
    for (const provider of ["gcp", "gcp-firebase"] as const) {
      const adders = stackIamInvariants(provider).filter(
        (i) => i.role === "roles/secretmanager.secretVersionAdder",
      );
      expect(adders).toEqual([
        expect.objectContaining({
          stackResource: "admin-operator-oauth-client-version-adder",
          member: "run-sa",
          target: { kind: "secret", name: "operator-oauth-client" },
          onFailure: "warn",
        }),
      ]);
      const adminReads = stackIamInvariants(provider).filter(
        (i) =>
          i.member === "run-sa" &&
          i.role === "roles/secretmanager.secretAccessor" &&
          i.target.kind === "secret" &&
          (i.target.name.startsWith("mcp-oauth") || i.target.name === "operator-oauth-client"),
      );
      expect(adminReads).toEqual([]);
    }
  });

  it("mounts the OAuth client on the MCP-Auth-Proxy only, at latest, as the file its env names", () => {
    expect(SERVICE_SECRET_FILES.admin).toEqual([]);
    expect(SERVICE_SECRET_FILES.gateway).toEqual([]);
    expect(SERVICE_SECRET_FILES["mcp-auth-proxy"]).toEqual([OPERATOR_OAUTH_CLIENT_FILE]);
    expect(secretFileVolumesTemplate("mcp-auth-proxy", "production")).toEqual({
      volumes: [
        {
          name: "operator-oauth-client",
          secret: {
            secret: "caelo-production-operator-oauth-client",
            items: [{ version: "latest", path: "client.json" }],
          },
        },
      ],
      volumeMounts: [
        { name: "operator-oauth-client", mountPath: "/secrets/operator-oauth-client" },
      ],
    });
    expect(secretFileVolumesTemplate("admin", "production")).toEqual({
      volumes: [],
      volumeMounts: [],
    });
  });
});

describe("planSecretFiles / planRequestTimeout (upgrade)", () => {
  const empty = { executionEnvironment: null, volumes: [], mounts: [] };

  it("mounts a missing secret file with the documented --update-secrets path form", () => {
    expect(planSecretFiles(empty, [OPERATOR_OAUTH_CLIENT_FILE], "production")).toEqual({
      ok: true,
      flags: [
        "--update-secrets=/secrets/operator-oauth-client/client.json=caelo-production-operator-oauth-client:latest",
      ],
      changes: [
        "secret file /secrets/operator-oauth-client/client.json: (none) → caelo-production-operator-oauth-client:latest",
      ],
    });
  });

  it("leaves the file the stack (or an earlier upgrade) mounted alone, whatever its volume is called", () => {
    for (const name of ["operator-oauth-client", "secret-1a2b3c"]) {
      const live = {
        executionEnvironment: null,
        volumes: [
          {
            name,
            secret: {
              secretName: "projects/42/secrets/caelo-production-operator-oauth-client",
              items: [{ key: "latest", path: "client.json" }],
            },
          },
        ],
        mounts: [{ name, mountPath: "/secrets/operator-oauth-client" }],
      };
      expect(planSecretFiles(live, [OPERATOR_OAUTH_CLIENT_FILE], "production")).toEqual({
        ok: true,
        flags: [],
        changes: [],
      });
    }
  });

  it("#914 — moves the MCP-Auth-Proxy (the old gateway service) from the retired mcp-oauth-client mount to the renamed secret in one roll", () => {
    const live = {
      executionEnvironment: null,
      volumes: [
        {
          name: "mcp-oauth-client",
          secret: {
            secretName: "caelo-production-mcp-oauth-client",
            items: [{ key: "latest", path: "client.json" }],
          },
        },
      ],
      mounts: [{ name: "mcp-oauth-client", mountPath: "/secrets/mcp-oauth-client" }],
    };
    expect(RETIRED_SECRET_FILES["mcp-auth-proxy"].map((f) => f.mountDir)).toEqual([
      "/secrets/mcp-oauth-client",
    ]);
    // #1328 — and the gateway gives the client file up altogether.
    expect(RETIRED_SECRET_FILES.gateway.map((f) => f.mountDir)).toEqual([
      "/secrets/mcp-oauth-client",
      "/secrets/operator-oauth-client",
    ]);
    const plan = planSecretFiles(
      live,
      [OPERATOR_OAUTH_CLIENT_FILE],
      "production",
      RETIRED_SECRET_FILES["mcp-auth-proxy"],
    );
    expect(plan.ok && plan.flags).toEqual([
      "--remove-secrets=/secrets/mcp-oauth-client/client.json",
      "--remove-volume-mount=/secrets/mcp-oauth-client",
      "--remove-volume=mcp-oauth-client",
      "--update-secrets=/secrets/operator-oauth-client/client.json=caelo-production-operator-oauth-client:latest",
    ]);
    // Converged: nothing left to remove or mount.
    const after = {
      executionEnvironment: null,
      volumes: [
        {
          name: "operator-oauth-client",
          secret: {
            secretName: "caelo-production-operator-oauth-client",
            items: [{ key: "latest", path: "client.json" }],
          },
        },
      ],
      mounts: [{ name: "operator-oauth-client", mountPath: "/secrets/operator-oauth-client" }],
    };
    expect(
      planSecretFiles(
        after,
        [OPERATOR_OAUTH_CLIENT_FILE],
        "production",
        RETIRED_SECRET_FILES["mcp-auth-proxy"],
      ),
    ).toEqual({ ok: true, flags: [], changes: [] });
  });

  it("#914 — deletes the retired secret after the roll; an absent one is fine", async () => {
    const install = {
      provider: "gcp-firebase" as const,
      projectId: "acme",
      region: "europe-west1",
      env: "production",
    };
    const present = fakeGcloud({
      "secrets describe caelo-production-mcp-oauth-client": ok("projects/1/secrets/x\n"),
      "secrets delete caelo-production-mcp-oauth-client": ok(),
    });
    expect(await deleteRetiredSecrets(install, { run: present.run })).toEqual([
      {
        id: "secret caelo-production-mcp-oauth-client",
        status: "removed",
        why: "the Google sign-in client moved to operator-oauth-client (#914)",
      },
    ]);
    expect(present.calls).toContain(
      "secrets delete caelo-production-mcp-oauth-client --project=acme --quiet",
    );
    const absent = fakeGcloud({
      "secrets describe caelo-production-mcp-oauth-client": fail("NOT_FOUND: Secret not found"),
    });
    const outcomes = await deleteRetiredSecrets(install, { run: absent.run });
    expect(outcomes.map((o) => o.status)).toEqual(["absent"]);
    expect(absent.calls.some((c) => c.startsWith("secrets delete"))).toBe(false);
    const denied = fakeGcloud({
      "secrets describe caelo-production-mcp-oauth-client": ok("x"),
      "secrets delete caelo-production-mcp-oauth-client": fail("PERMISSION_DENIED"),
    });
    expect((await deleteRetiredSecrets(install, { run: denied.run }))[0]).toMatchObject({
      status: "failed",
      error: "PERMISSION_DENIED",
    });
  });

  it("#914 — retires the old secret and the old env names", () => {
    expect(RETIRED_RUNTIME_SECRETS.map((s) => s.name)).toEqual(["mcp-oauth-client"]);
    expect(RETIRED_SERVICE_ENV.gateway).toContain("CAELO_MCP_OAUTH_CLIENT_FILE");
    expect(RETIRED_SERVICE_ENV.admin).toContain("CAELO_MCP_OAUTH_CLIENT_STORE");
    expect(CLI_GENERATED_SECRETS).not.toContain("mcp-oauth-client" as never);
  });

  it("refuses something else mounted where the client belongs (a pinned version included)", () => {
    const live = {
      executionEnvironment: null,
      volumes: [
        {
          name: "v",
          secret: {
            secretName: "caelo-production-operator-oauth-client",
            items: [{ key: "3", path: "client.json" }],
          },
        },
      ],
      mounts: [{ name: "v", mountPath: "/secrets/operator-oauth-client" }],
    };
    const plan = planSecretFiles(live, [OPERATOR_OAUTH_CLIENT_FILE], "production");
    expect(plan.ok).toBe(false);
    if (!plan.ok)
      expect(plan.error).toContain("--remove-volume-mount=/secrets/operator-oauth-client");
  });

  it("raises the MCP-Auth-Proxy's request timeout to the contract's", () => {
    expect(MCP_AUTH_PROXY_TIMEOUT_SECONDS).toBe(3600);
    expect(planRequestTimeout(null, 3600).ok && planRequestTimeout(null, 3600)).toEqual({
      ok: true,
      flags: ["--timeout=3600"],
      changes: ["request timeout: (default 300)s → 3600s"],
    });
    expect(planRequestTimeout(60, 3600)).toMatchObject({ flags: ["--timeout=3600"] });
    expect(planRequestTimeout(3600, 3600)).toEqual({ ok: true, flags: [], changes: [] });
  });
});

const firebase: RemoteMcpTarget = {
  provider: "gcp-firebase",
  projectId: "acme",
  region: "europe-west1",
  env: "production",
  domain: "acme.com",
  services: {
    admin: "caelo-production-admin-aaa",
    gateway: "caelo-production-data-gateway",
    "staging-gateway": "caelo-production-staging-gateway",
    "mcp-auth-proxy": "caelo-production-gateway-bbb",
  },
};

const ANCESTORS_IN_ORG = ok(
  JSON.stringify([
    { id: "acme", type: "project" },
    { id: "555", type: "folder" },
    { id: "123456", type: "organization" },
  ]),
);

describe("resolveRemoteMcpIdentity", () => {
  it("gcp-firebase: reads the project number, the admin's and the MCP-Auth-Proxy's URLs and the organisation", async () => {
    const { run } = fakeGcloud({
      "projects describe acme": ok("42\n"),
      "projects get-ancestors acme": ANCESTORS_IN_ORG,
      "organizations describe 123456": ok("Acme.com\n"),
      "run services describe caelo-production-admin-aaa": ok(
        "https://caelo-production-admin-aaa-xyz.a.run.app\n",
      ),
      "run services describe caelo-production-gateway-bbb": ok(
        "https://caelo-production-gateway-bbb-xyz.a.run.app\n",
      ),
    });
    const r = await resolveRemoteMcpIdentity(firebase, { run });
    expect(r).toEqual({
      ok: true,
      identity: {
        adminUrl: "https://caelo-production-admin-aaa-xyz.a.run.app",
        mcpPublicUrl: "https://caelo-production-gateway-bbb-xyz.a.run.app",
        iapAudience: "/projects/42/locations/europe-west1/services/caelo-production-admin-aaa",
        googleOrgDomain: "acme.com",
      },
    });
  });

  it("#914 — an unreadable organisation is reported, not fatal, and sets no domain", async () => {
    const { run } = fakeGcloud({
      "projects describe acme": ok("42\n"),
      "projects get-ancestors acme": ANCESTORS_IN_ORG,
      "organizations describe 123456": fail("PERMISSION_DENIED: organizations.get"),
      "run services describe caelo-production-admin-aaa": ok("https://a-xyz.a.run.app\n"),
      "run services describe caelo-production-gateway-bbb": ok("https://g-xyz.a.run.app\n"),
    });
    const r = await resolveRemoteMcpIdentity(firebase, { run });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.identity.googleOrgDomain).toBeUndefined();
    expect(r.orgDomainError).toContain("Organization Viewer");
  });

  it("gcp: reads the IAP-enabled admin backend service's numeric id", async () => {
    const { run, calls } = fakeGcloud({
      "projects describe acme": ok("42"),
      "compute backend-services list": ok("987654321\n"),
    });
    const r = await resolveRemoteMcpIdentity({ ...firebase, provider: "gcp" }, { run });
    expect(r.ok && r.identity.iapAudience).toBe("/projects/42/global/backendServices/987654321");
    expect(
      calls.some((c) =>
        c.includes("--filter=name~^caelo-production-admin-backend AND iap.enabled=true"),
      ),
    ).toBe(true);
  });

  it("fails loudly instead of guessing when the backend is ambiguous", async () => {
    const { run } = fakeGcloud({
      "projects describe acme": ok("42"),
      "compute backend-services list": ok("1\n2\n"),
    });
    const r = await resolveRemoteMcpIdentity({ ...firebase, provider: "gcp" }, { run });
    expect(r.ok).toBe(false);
  });
});

describe("resolveGoogleOrgDomain (#914)", () => {
  it("reads the organisation's domain through the project's ancestors", async () => {
    const { run, calls } = fakeGcloud({
      "projects get-ancestors acme": ANCESTORS_IN_ORG,
      "organizations describe 123456": ok("acme.com\n"),
    });
    expect(await resolveGoogleOrgDomain("acme", { run })).toEqual({ ok: true, domain: "acme.com" });
    expect(calls).toContain("organizations describe 123456 --format=value(displayName)");
  });

  it("answers `none` for a project in no organisation", async () => {
    const { run } = fakeGcloud({
      "projects get-ancestors acme": ok(JSON.stringify([{ id: "acme", type: "project" }])),
    });
    expect(await resolveGoogleOrgDomain("acme", { run })).toEqual({ ok: true, domain: "none" });
  });

  it("fails naming the missing role when the organisation cannot be read", async () => {
    const { run } = fakeGcloud({
      "projects get-ancestors acme": ANCESTORS_IN_ORG,
      "organizations describe 123456": ok("not a domain\n"),
    });
    const r = await resolveGoogleOrgDomain("acme", { run });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Organization Viewer");
  });
});

const serviceJson = (env: { name: string; value: string }[]) =>
  ok(JSON.stringify({ spec: { template: { spec: { containers: [{ env }] } } } }));
const DESCRIBE_JSON = "--region=europe-west1 --project=acme --format=json";

describe("findRemoteMcpTarget (#1082)", () => {
  it("finds the Pulumi-suffixed services by prefix and names the fixed one (#1328)", async () => {
    const { run } = fakeGcloud({
      "run services list --region europe-west1 --project acme --filter metadata.name~^caelo-production-admin":
        ok("caelo-production-admin-aaa\n"),
      "run services list --region europe-west1 --project acme --filter metadata.name~^caelo-production-gateway":
        ok("caelo-production-gateway-bbb\n"),
    });
    const { services: _s, ...base } = firebase;
    expect(await findRemoteMcpTarget(base, { run })).toEqual({ ok: true, target: firebase });
  });

  it("fails naming the service it cannot find (a fresh install before its first up)", async () => {
    const { run } = fakeGcloud({ "run services list": ok("") });
    const { services: _s, ...base } = firebase;
    const r = await findRemoteMcpTarget(base, { run });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("caelo-production-admin* Cloud Run service");
  });
});

describe("resolveStackRemoteMcpIdentity (#1082)", () => {
  const base = {
    "projects describe acme": ok("42\n"),
    "projects get-ancestors acme": ANCESTORS_IN_ORG,
    "run services describe caelo-production-admin-aaa": ok("https://a-xyz.a.run.app\n"),
    "run services describe caelo-production-gateway-bbb": ok("https://g-xyz.a.run.app\n"),
  };

  it("is the live identity when the organisation is readable", async () => {
    const { run } = fakeGcloud({ ...base, "organizations describe 123456": ok("acme.com\n") });
    const r = await resolveStackRemoteMcpIdentity(firebase, { run });
    expect(r.ok && r.identity.googleOrgDomain).toBe("acme.com");
    expect(r.ok && r.orgDomainError).toBeUndefined();
  });

  it("carries the admin's live organisation domain over when it cannot be read now", async () => {
    // The stack owns the var: leaving it out of the config would remove it
    // on the next `up`, where a gcloud roll leaves it as it is.
    const { run } = fakeGcloud({
      ...base,
      "organizations describe 123456": fail("PERMISSION_DENIED"),
      [`run services describe caelo-production-admin-aaa ${DESCRIBE_JSON}`]: serviceJson([
        { name: "CAELO_GOOGLE_ORG_DOMAIN", value: "acme.com" },
      ]),
    });
    const r = await resolveStackRemoteMcpIdentity(firebase, { run });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.identity.googleOrgDomain).toBe("acme.com");
    expect(r.orgDomainError).toContain("Organization Viewer");
  });

  it("sets no domain when neither the organisation nor the admin has one", async () => {
    const { run } = fakeGcloud({
      ...base,
      "organizations describe 123456": fail("PERMISSION_DENIED"),
      [`run services describe caelo-production-admin-aaa ${DESCRIBE_JSON}`]: serviceJson([]),
    });
    const r = await resolveStackRemoteMcpIdentity(firebase, { run });
    expect(r.ok && r.identity.googleOrgDomain).toBeUndefined();
  });
});

describe("checkRemoteMcpIdentityEnv (#1082)", () => {
  const identity = {
    adminUrl: "https://a.run.app",
    mcpPublicUrl: "https://g.run.app",
    iapAudience: "/projects/42/locations/europe-west1/services/caelo-production-admin-aaa",
  };
  const full = remoteMcpIdentityEnv(identity);
  const plain = (env: ReturnType<typeof remoteMcpIdentityEnv>["admin"]) =>
    env.map((e) => ({ name: e.name, value: "value" in e ? e.value : "" }));

  it("reports no drift when the services carry the vars, and never updates a service", async () => {
    const { run, calls } = fakeGcloud({
      [`run services describe caelo-production-admin-aaa ${DESCRIBE_JSON}`]: serviceJson(
        plain(full.admin),
      ),
      [`run services describe caelo-production-data-gateway ${DESCRIBE_JSON}`]: serviceJson([]),
      [`run services describe caelo-production-gateway-bbb ${DESCRIBE_JSON}`]: serviceJson(
        plain(full["mcp-auth-proxy"]),
      ),
    });
    const r = await checkRemoteMcpIdentityEnv(firebase, identity, { run });
    expect(r).toEqual({
      ok: true,
      drift: { admin: [], gateway: [], "staging-gateway": [], "mcp-auth-proxy": [] },
    });
    expect(calls.some((c) => c.startsWith("run services update"))).toBe(false);
  });

  it("names what a service lacks", async () => {
    const { run, calls } = fakeGcloud({
      [`run services describe caelo-production-admin-aaa ${DESCRIBE_JSON}`]: serviceJson(
        plain(full.admin),
      ),
      [`run services describe caelo-production-data-gateway ${DESCRIBE_JSON}`]: serviceJson([]),
      [`run services describe caelo-production-gateway-bbb ${DESCRIBE_JSON}`]: serviceJson([]),
    });
    const r = await checkRemoteMcpIdentityEnv(firebase, identity, { run });
    expect(r.ok && r.drift.gateway).toEqual([]);
    expect(r.ok && r.drift["mcp-auth-proxy"].map((c) => c.name)).toEqual([
      "CAELO_ADMIN_URL",
      "CAELO_MCP_PUBLIC_URL",
    ]);
    expect(calls.some((c) => c.startsWith("run services update"))).toBe(false);
  });
});

describe("gcp load balancer (remote-mcp-edge)", () => {
  it("evaluates the /api/mcp/* rule before the general ban and the OWASP packs", () => {
    expect(MCP_ARMOR_RULE.priority).toBeLessThan(GENERAL_RATE_LIMIT_PRIORITY);
    for (const p of OWASP_RULE_PRIORITIES) expect(MCP_ARMOR_RULE.priority).toBeLessThan(p);
    // A throttle (no ban) whose conforming action is `allow` — terminal.
    expect(MCP_ARMOR_RULE.action).toBe("throttle");
    expect(MCP_ARMOR_RULE.conformAction).toBe("allow");
    expect(MCP_ARMOR_RULE.expression).toBe(`request.path.matches('${MCP_ARMOR_PATH_PATTERN}')`);
  });

  it("covers exactly the broker's paths; a traversal never borrows the MCP rule", async () => {
    // RE2 and JS agree on this pattern (anchors, alternation, classes only).
    // Cloud Armor refuses capture groups (scratch install of v0.11.17).
    expect(MCP_ARMOR_PATH_PATTERN).not.toMatch(/\((?!\?:)/);
    const re = new RegExp(MCP_ARMOR_PATH_PATTERN);
    for (const p of [
      "/api/mcp/chat",
      "/api/mcp/admin",
      "/api/mcp/oauth/authorize",
      "/api/mcp/oauth/google-callback",
      "/api/mcp/oauth/token",
      "/api/mcp/oauth/register",
      "/api/mcp/oauth/status",
      "/api/mcp/oauth/protected-resource/chat",
    ]) {
      expect(re.test(p)).toBe(true);
    }
    for (const p of [
      "/api/mcp/../forms/submit",
      "/api/mcp/%2e%2e/comments/post",
      "/api/mcp/chat/../../forms/submit",
      "/api/mcp/chat/x",
      "/api/mcp/oauth/token/../../../forms",
      "/api/mcp/",
      "/api/forms/submit",
    ]) {
      expect(re.test(p)).toBe(false);
    }
    // Every /api/mcp/ route the gateway documents — the consent page's
    // POST /api/mcp/oauth/authorize included — is covered.
    const routes = await Bun.file(
      new URL("../../../apps/mcp-auth-proxy/src/routes.ts", import.meta.url),
    ).text();
    const documented = [...routes.matchAll(/^ \* {3}[A-Z|]+ +(\/api\/mcp\/[^\s]+)/gm)]
      .map((m) => m[1] as string)
      .flatMap((p) =>
        p.includes("{") ? ["chat", "admin"].map((s) => p.replace(/\{(chat,admin|s)\}/, s)) : [p],
      );
    expect(documented).toContain("/api/mcp/oauth/authorize");
    expect(documented.length).toBeGreaterThanOrEqual(8);
    for (const p of documented) expect(re.test(p)).toBe(true);
    // Why it matters: the gateway's URL parser resolves such a path to a public write.
    expect(new URL("https://h/api/mcp/%2e%2e/comments/post").pathname).toBe("/api/comments/post");
  });

  it("throttles at the edge exactly where the gateway's own proxy bucket does (#899)", async () => {
    // Both key on the client address (Cloud Armor: the LB's view; the
    // gateway: CAELO_TRUSTED_PROXY_HOPS). Neither may be the tighter one by
    // accident — a lower edge limit would 429 traffic the broker allows.
    const src = await Bun.file(
      new URL("../../../apps/mcp-auth-proxy/src/rate-limit.ts", import.meta.url),
    ).text();
    const proxy = /proxy: \{ capacity: (\d+), windowSeconds: (\d+) \}/.exec(src);
    expect(proxy).not.toBeNull();
    expect([Number(proxy?.[1]), Number(proxy?.[2])]).toEqual([
      MCP_ARMOR_RULE.count,
      MCP_ARMOR_RULE.intervalSec,
    ]);
  });

  it("the stack shape and the gcloud flags describe the same rule", () => {
    const args = mcpArmorRuleArgs();
    expect(
      isMcpArmorRule({ ...args, match: { expr: { expression: args.match.expr.expression } } }),
    ).toBe(true);
    expect(mcpArmorRuleFlags()).toEqual([
      `--description=${MCP_ARMOR_RULE.description}`,
      `--expression=request.path.matches('${MCP_ARMOR_PATH_PATTERN}')`,
      "--action=throttle",
      "--rate-limit-threshold-count=600",
      "--rate-limit-threshold-interval-sec=60",
      "--conform-action=allow",
      "--exceed-action=deny-429",
      "--enforce-on-key=IP",
    ]);
  });

  it("#1328 — the gcp stack's own WAF policy no longer carries the rule (the proxy's policy does)", async () => {
    const src = await Bun.file(new URL("../stacks/gcp/index.ts", import.meta.url)).text();
    expect(src).not.toContain("mcpArmorRuleArgs");
  });

  const PROXY_BACKEND =
    "https://www.googleapis.com/compute/v1/projects/acme/global/backendServices/caelo-production-mcp-auth-proxy-backend";
  const map = (paths: string[], extra: object[] = []): LiveUrlMap => ({
    name: "caelo-production-url-map-abc",
    fingerprint: "fp",
    hostRules: [
      { hosts: ["acme.com"], pathMatcher: "public" },
      { hosts: ["admin.acme.com"], pathMatcher: "admin" },
    ],
    pathMatchers: [
      {
        name: "public",
        pathRules: [
          { paths, service: "projects/acme/global/backendServices/gw" },
          ...(extra as never[]),
        ],
      },
      { name: "admin", pathRules: [] },
    ],
  });
  const redirect = { paths: ["/old"], urlRedirect: { pathRedirect: "/new" } };

  it("#1328 — moves the remote-MCP paths off the gateway's rule onto the proxy's, keeping redirects", () => {
    // What #806 left: the discovery paths on the gateway's /api/* rule.
    const plan = planUrlMapPaths(
      [map(["/api/*", ...GCP_MCP_AUTH_PROXY_PATHS.slice(1)], [redirect])],
      "acme.com",
      PROXY_BACKEND,
    );
    if (!plan.ok) throw new Error(plan.error);
    const rules = plan.map.pathMatchers?.[0]?.pathRules ?? [];
    expect(rules).toEqual([
      { paths: [...GCP_GATEWAY_PATHS], service: "projects/acme/global/backendServices/gw" },
      { paths: [...GCP_MCP_AUTH_PROXY_PATHS], service: PROXY_BACKEND },
      redirect,
    ]);
    expect(plan.changes).toHaveLength(2);
    expect(plan.map.fingerprint).toBe("fp");
    // The admin host's matcher is not touched.
    expect(plan.map.pathMatchers?.[1]).toEqual({ name: "admin", pathRules: [] });
  });

  it("#1328 — is idempotent, and brings a drifted proxy rule back to its paths", () => {
    const converged = map(
      [...GCP_GATEWAY_PATHS],
      [{ paths: [...GCP_MCP_AUTH_PROXY_PATHS], service: PROXY_BACKEND }, redirect],
    );
    const again = planUrlMapPaths([converged], "acme.com", PROXY_BACKEND);
    expect(again.ok && again.changes).toEqual([]);
    expect(again.ok && again.map).toBe(converged);

    const drifted = map(
      [...GCP_GATEWAY_PATHS],
      [{ paths: ["/api/mcp/*"], service: PROXY_BACKEND }],
    );
    const fixed = planUrlMapPaths([drifted], "acme.com", PROXY_BACKEND);
    if (!fixed.ok) throw new Error(fixed.error);
    expect(fixed.map.pathMatchers?.[0]?.pathRules?.[1]).toEqual({
      paths: [...GCP_MCP_AUTH_PROXY_PATHS],
      service: PROXY_BACKEND,
    });
  });

  it("refuses a map without the gateway rule instead of inventing one", () => {
    const plan = planUrlMapPaths([map(["/other/*"])], "acme.com", PROXY_BACKEND);
    expect(plan.ok).toBe(false);
    expect(planUrlMapPaths([], "acme.com", PROXY_BACKEND).ok).toBe(false);
  });

  // As real gcloud prints it: a one-element list.
  const policyJson = (rules: object[]) => ok(JSON.stringify([{ rules }]));
  const PROXY_POLICY = "caelo-production-mcp-auth-proxy-armor";

  it("#1328 — creates the proxy's own policy and its rule when missing", async () => {
    let created = false;
    const calls: string[] = [];
    const run: GcloudRunner = async (args) => {
      const line = args.join(" ");
      calls.push(line);
      if (line.startsWith(`compute security-policies describe ${PROXY_POLICY}`)) {
        return created ? policyJson([{ priority: 2147483647 }]) : fail("NOT_FOUND: not found");
      }
      if (line.startsWith(`compute security-policies create ${PROXY_POLICY}`)) {
        created = true;
        return ok();
      }
      if (line.startsWith("compute security-policies rules create 900")) return ok();
      return fail(`unexpected: ${line}`);
    };
    expect(await ensureMcpArmorRule({ projectId: "acme", env: "production" }, { run })).toEqual({
      ok: true,
      policy: PROXY_POLICY,
      action: "created",
    });
    expect(calls.at(-1)).toContain(`--security-policy=${PROXY_POLICY}`);
    // Never the gateway's policy.
    expect(calls.some((c) => c.includes("-waf"))).toBe(false);
  });

  it("leaves a rule in shape alone and brings a drifted one back", async () => {
    const args = mcpArmorRuleArgs();
    const present = fakeGcloud({
      "compute security-policies describe": policyJson([{ ...args }]),
    });
    const r = await ensureMcpArmorRule({ projectId: "acme", env: "production" }, present);
    expect(r.ok && r.action).toBe("present");
    expect(present.calls.some((c) => c.includes("rules "))).toBe(false);

    const drifted = fakeGcloud({
      "compute security-policies describe": policyJson([{ ...args, action: "allow" }]),
      "compute security-policies rules update 900": ok(),
    });
    const d = await ensureMcpArmorRule({ projectId: "acme", env: "production" }, drifted);
    expect(d.ok && d.action).toBe("updated");
  });

  it("#1328 — takes the MCP rule off the gateway's policy, and only exactly that rule", async () => {
    const args = mcpArmorRuleArgs();
    const withRule = fakeGcloud({
      "compute security-policies list": ok("caelo-production-waf-1a2b\n"),
      "compute security-policies describe caelo-production-waf-1a2b": policyJson([{ ...args }]),
      "compute security-policies rules delete 900": ok(),
    });
    expect(
      await retireGatewayMcpArmorRule({ projectId: "acme", env: "production" }, withRule),
    ).toEqual({ ok: true, removed: "caelo-production-waf-1a2b" });
    expect(withRule.calls.at(-1)).toContain("--security-policy=caelo-production-waf-1a2b");

    // Someone's own rule at the priority stays.
    const own = fakeGcloud({
      "compute security-policies list": ok("caelo-production-waf-1a2b\n"),
      "compute security-policies describe caelo-production-waf-1a2b": policyJson([
        { priority: 900, action: "deny(403)" },
      ]),
    });
    expect(await retireGatewayMcpArmorRule({ projectId: "acme", env: "production" }, own)).toEqual({
      ok: true,
      removed: null,
    });
    expect(own.calls.some((c) => c.includes("rules delete"))).toBe(false);
  });

  it("#1328 — creates the proxy's NEG and backend with its policy, then is a no-op", async () => {
    const target = { projectId: "acme", region: "europe-west1", env: "production" };
    const missing = fakeGcloud({
      "compute network-endpoint-groups describe": fail("NOT_FOUND: was not found"),
      "compute network-endpoint-groups create": ok(),
      "compute backend-services describe": fail("NOT_FOUND: was not found"),
      "compute backend-services create": ok(JSON.stringify([{ selfLink: PROXY_BACKEND }])),
      "compute backend-services update": ok(),
      "compute backend-services add-backend": ok(),
    });
    const r = await ensureMcpAuthProxyBackend(target, missing);
    expect(r.ok && r.backend).toBe(PROXY_BACKEND);
    expect(missing.calls).toContain(
      "compute network-endpoint-groups create caelo-production-mcp-auth-proxy-neg --region=europe-west1 --project=acme --network-endpoint-type=serverless --cloud-run-service=caelo-production-mcp-auth-proxy --quiet",
    );
    // `backend-services create` has no --security-policy flag (scratch
    // install of v0.11.17, 2026-11-05): `update` attaches the policy.
    expect(
      missing.calls.find((c) => c.startsWith("compute backend-services create")),
    ).not.toContain("--security-policy");
    expect(missing.calls.find((c) => c.startsWith("compute backend-services update"))).toContain(
      `--security-policy=${PROXY_POLICY}`,
    );
    expect(
      missing.calls.find((c) => c.startsWith("compute backend-services add-backend")),
    ).toContain("--network-endpoint-group=caelo-production-mcp-auth-proxy-neg");

    const present = fakeGcloud({
      "compute network-endpoint-groups describe": ok("caelo-production-mcp-auth-proxy-neg\n"),
      "compute backend-services describe": ok(
        JSON.stringify({
          selfLink: PROXY_BACKEND,
          securityPolicy: `https://www.googleapis.com/compute/v1/projects/acme/global/securityPolicies/${PROXY_POLICY}`,
          backends: [
            {
              group:
                "https://www.googleapis.com/compute/v1/projects/acme/regions/europe-west1/networkEndpointGroups/caelo-production-mcp-auth-proxy-neg",
            },
          ],
        }),
      ),
    });
    const again = await ensureMcpAuthProxyBackend(target, present);
    expect(again).toEqual({ ok: true, backend: PROXY_BACKEND, done: [] });

    // A backend an earlier run left without its policy gets it attached.
    const bare = fakeGcloud({
      "compute network-endpoint-groups describe": ok("caelo-production-mcp-auth-proxy-neg\n"),
      "compute backend-services describe": ok(
        JSON.stringify({
          selfLink: PROXY_BACKEND,
          backends: [{ group: "x/networkEndpointGroups/caelo-production-mcp-auth-proxy-neg" }],
        }),
      ),
      "compute backend-services update": ok(),
    });
    expect((await ensureMcpAuthProxyBackend(target, bare)).ok).toBe(true);
    expect(bare.calls.find((c) => c.startsWith("compute backend-services update"))).toContain(
      `--security-policy=${PROXY_POLICY}`,
    );
  });

  it("creates the backend with the http port name a serverless NEG needs", async () => {
    const missing = fakeGcloud({
      "compute network-endpoint-groups describe": ok("caelo-production-mcp-auth-proxy-neg\n"),
      "compute backend-services describe": fail("NOT_FOUND: was not found"),
      "compute backend-services create": ok(JSON.stringify([{ selfLink: PROXY_BACKEND }])),
    });
    await ensureMcpAuthProxyBackend(
      { projectId: "acme", region: "europe-west1", env: "production" },
      missing,
    );
    expect(missing.calls.find((c) => c.startsWith("compute backend-services create"))).toContain(
      "--protocol=HTTPS --port-name=http",
    );
  });

  it("repairs a backend an earlier run left with the https port name, before add-backend", async () => {
    const left = fakeGcloud({
      "compute network-endpoint-groups describe": ok("caelo-production-mcp-auth-proxy-neg\n"),
      "compute backend-services describe": ok(
        JSON.stringify({ selfLink: PROXY_BACKEND, portName: "https", backends: [] }),
      ),
      "compute backend-services update": ok(),
      "compute backend-services add-backend": ok(),
    });
    const r = await ensureMcpAuthProxyBackend(
      { projectId: "acme", region: "europe-west1", env: "production" },
      left,
    );
    expect(r.ok).toBe(true);
    const writes = left.calls.filter((c) =>
      /^compute backend-services (update|add-backend)/.test(c),
    );
    expect(writes[0]).toContain("--port-name=http");
    expect(writes.at(-1)).toContain("add-backend");
  });

  it("#1328 — ensureRemoteMcpEdge: service, policy, backend, URL map, then the gateway rule; no-op on gcp-firebase", async () => {
    expect(
      await ensureRemoteMcpEdge({
        provider: "gcp-firebase",
        projectId: "acme",
        region: "europe-west1",
        env: "production",
        domain: "acme.com",
        mcpAuthProxyImageRef: "img",
      }),
    ).toEqual({ ok: true, done: [] });

    const order: string[] = [];
    const run: GcloudRunner = async (args) => {
      const line = args.join(" ");
      const step = [
        ["run services describe caelo-production-mcp-auth-proxy", "service"],
        [`compute security-policies describe ${PROXY_POLICY}`, "policy"],
        ["compute network-endpoint-groups describe", "neg"],
        ["compute backend-services describe", "backend"],
        ["compute url-maps list", "url-map"],
        ["compute security-policies list", "gateway-policy"],
      ].find(([prefix]) => line.startsWith(prefix as string))?.[1];
      if (step) order.push(step);
      if (line.startsWith("run services describe")) return ok("caelo-production-mcp-auth-proxy\n");
      if (line.startsWith(`compute security-policies describe ${PROXY_POLICY}`)) {
        return policyJson([{ ...mcpArmorRuleArgs() }]);
      }
      if (line.startsWith("compute network-endpoint-groups describe")) return ok("neg\n");
      if (line.startsWith("compute backend-services describe")) {
        return ok(
          JSON.stringify({
            selfLink: PROXY_BACKEND,
            securityPolicy: `x/securityPolicies/${PROXY_POLICY}`,
            backends: [{ group: "x/networkEndpointGroups/caelo-production-mcp-auth-proxy-neg" }],
          }),
        );
      }
      if (line.startsWith("compute url-maps list")) {
        return ok(
          JSON.stringify([
            map(
              [...GCP_GATEWAY_PATHS],
              [{ paths: [...GCP_MCP_AUTH_PROXY_PATHS], service: PROXY_BACKEND }],
            ),
          ]),
        );
      }
      if (line.startsWith("compute security-policies list")) return ok("caelo-production-waf-1\n");
      if (line.startsWith("compute security-policies describe caelo-production-waf-1")) {
        return policyJson([]);
      }
      return fail(`unexpected: ${line}`);
    };
    const r = await ensureRemoteMcpEdge(
      {
        provider: "gcp",
        projectId: "acme",
        region: "europe-west1",
        env: "production",
        domain: "acme.com",
        mcpAuthProxyImageRef: "img",
      },
      { run },
    );
    expect(r.ok).toBe(true);
    expect(order).toEqual(["service", "policy", "neg", "backend", "url-map", "gateway-policy"]);
  });
});
