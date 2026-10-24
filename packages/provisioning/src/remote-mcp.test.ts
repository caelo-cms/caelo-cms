// SPDX-License-Identifier: MPL-2.0

/**
 * #806 — remote MCP's provisioning: the contract pieces (identity env,
 * secrets, IAM), the gateway's secret file + timeout planning, and the CLI
 * steps (identity resolution, LB path rules, Cloud Armor rule).
 */

import { describe, expect, it } from "bun:test";
import { GCP_PUBLIC_BASE_PATHS } from "@caelo-cms/shared";
import type { GcloudResult } from "./gcloud.js";
import type { GcloudRunner } from "./gcloud-retry.js";
import {
  checkRemoteMcpIdentityEnv,
  ensureMcpArmorRule,
  findRemoteMcpTarget,
  type LiveUrlMap,
  planUrlMapPaths,
  type RemoteMcpTarget,
  resolveGoogleOrgDomain,
  resolveRemoteMcpIdentity,
  resolveStackRemoteMcpIdentity,
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
  GATEWAY_TIMEOUT_SECONDS,
  GATEWAY_TRUSTED_PROXY_HOPS,
  GENERATED_SECRET_FORMAT,
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

  it("gcp-firebase: the gateway's and admin's Cloud Run URLs, the service's audience", () => {
    expect(
      remoteMcpIdentity({
        provider: "gcp-firebase",
        projectNumber: "42",
        region: "europe-west1",
        adminServiceName: "caelo-production-admin-aaa",
        adminServiceUrl: "https://caelo-production-admin-aaa-xyz.a.run.app/",
        gatewayServiceUrl: "https://caelo-production-gateway-bbb-xyz.a.run.app",
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
    // client (1). A broker URL on the Hosting path would pool every client
    // behind one CDN edge address.
    expect(GATEWAY_TRUSTED_PROXY_HOPS.gcp).toBe(2);
    expect(
      remoteMcpIdentity({
        provider: "gcp",
        domain: "acme.com",
        projectNumber: "42",
        adminBackendServiceId: "1",
      }).mcpPublicUrl,
    ).toBe("https://acme.com");
    expect(GATEWAY_TRUSTED_PROXY_HOPS["gcp-firebase"]).toBe(1);
    const firebase = remoteMcpIdentity({
      provider: "gcp-firebase",
      projectNumber: "42",
      region: "europe-west1",
      adminServiceName: "a",
      adminServiceUrl: "https://a-xyz.a.run.app",
      gatewayServiceUrl: "https://g-xyz.a.run.app",
    });
    expect(new URL(firebase.mcpPublicUrl).hostname.endsWith(".run.app")).toBe(true);
  });

  it("gives the admin the audience, public URL and its own URL, and the gateway the admin + public URL", () => {
    const env = remoteMcpIdentityEnv({ adminUrl: "A", mcpPublicUrl: "P", iapAudience: "AUD" });
    expect(env.admin).toEqual([
      { name: REMOTE_MCP_ENV.iapAudience, value: "AUD" },
      { name: REMOTE_MCP_ENV.mcpPublicUrl, value: "P" },
      // #914 — Google sign-in's self-check opens the admin signed out.
      { name: REMOTE_MCP_ENV.adminUrl, value: "A" },
    ]);
    expect(env.gateway).toEqual([
      { name: REMOTE_MCP_ENV.adminUrl, value: "A" },
      { name: REMOTE_MCP_ENV.mcpPublicUrl, value: "P" },
    ]);
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
    expect(known.gateway.map((e) => e.name)).not.toContain("CAELO_GOOGLE_ORG_DOMAIN");
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

  it("mounts the OAuth client on the gateway only, at latest, as the file its env names", () => {
    expect(SERVICE_SECRET_FILES.admin).toEqual([]);
    expect(SERVICE_SECRET_FILES.gateway).toEqual([OPERATOR_OAUTH_CLIENT_FILE]);
    expect(secretFileVolumesTemplate("gateway", "production")).toEqual({
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

  it("#914 — moves the gateway from the retired mcp-oauth-client mount to the renamed secret in one roll", () => {
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
    expect(RETIRED_SECRET_FILES.gateway.map((f) => f.mountDir)).toEqual([
      "/secrets/mcp-oauth-client",
    ]);
    const plan = planSecretFiles(
      live,
      [OPERATOR_OAUTH_CLIENT_FILE],
      "production",
      RETIRED_SECRET_FILES.gateway,
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
        RETIRED_SECRET_FILES.gateway,
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

  it("raises the gateway's request timeout to the contract's", () => {
    expect(GATEWAY_TIMEOUT_SECONDS).toBe(3600);
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
  services: { admin: "caelo-production-admin-aaa", gateway: "caelo-production-gateway-bbb" },
};

const ANCESTORS_IN_ORG = ok(
  JSON.stringify([
    { id: "acme", type: "project" },
    { id: "555", type: "folder" },
    { id: "123456", type: "organization" },
  ]),
);

describe("resolveRemoteMcpIdentity", () => {
  it("gcp-firebase: reads the project number, both services' URLs and the organisation", async () => {
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
  it("finds the Pulumi-suffixed services by prefix", async () => {
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
      [`run services describe caelo-production-gateway-bbb ${DESCRIBE_JSON}`]: serviceJson(
        plain(full.gateway),
      ),
    });
    const r = await checkRemoteMcpIdentityEnv(firebase, identity, { run });
    expect(r).toEqual({ ok: true, drift: { admin: [], gateway: [] } });
    expect(calls.some((c) => c.startsWith("run services update"))).toBe(false);
  });

  it("names what a service lacks", async () => {
    const { run, calls } = fakeGcloud({
      [`run services describe caelo-production-admin-aaa ${DESCRIBE_JSON}`]: serviceJson(
        plain(full.admin),
      ),
      [`run services describe caelo-production-gateway-bbb ${DESCRIBE_JSON}`]: serviceJson([]),
    });
    const r = await checkRemoteMcpIdentityEnv(firebase, identity, { run });
    expect(r.ok && r.drift.gateway.map((c) => c.name)).toEqual([
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
      new URL("../../../apps/api-gateway/src/mcp/routes.ts", import.meta.url),
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
      new URL("../../../apps/api-gateway/src/mcp/rate-limit.ts", import.meta.url),
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

  it("the gcp stack declares the rule from the shared module", async () => {
    const src = await Bun.file(new URL("../stacks/gcp/index.ts", import.meta.url)).text();
    expect(src).toContain("mcpArmorRuleArgs(),");
    expect(src.indexOf("mcpArmorRuleArgs(),")).toBeLessThan(
      src.indexOf("evaluatePreconfiguredWaf"),
    );
  });

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

  it("adds the discovery paths to the /api/* rule and keeps the admin's redirects", () => {
    const redirect = { paths: ["/old"], urlRedirect: { pathRedirect: "/new" } };
    const plan = planUrlMapPaths([map(["/api/*"], [redirect])], "acme.com");
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.added).toEqual(GCP_PUBLIC_BASE_PATHS.filter((p) => p !== "/api/*"));
    const rules = plan.map.pathMatchers?.[0]?.pathRules ?? [];
    expect(rules[0]?.paths).toEqual([...GCP_PUBLIC_BASE_PATHS]);
    expect(rules[1]).toEqual(redirect);
    expect(plan.map.fingerprint).toBe("fp");
  });

  it("changes nothing on a map that already routes them", () => {
    const plan = planUrlMapPaths([map([...GCP_PUBLIC_BASE_PATHS])], "acme.com");
    expect(plan.ok && plan.added).toEqual([]);
  });

  it("refuses a map without the gateway rule instead of inventing one", () => {
    const plan = planUrlMapPaths([map(["/other/*"])], "acme.com");
    expect(plan.ok).toBe(false);
    expect(planUrlMapPaths([], "acme.com").ok).toBe(false);
  });

  it("creates the Cloud Armor rule when missing, leaves it alone when in shape", async () => {
    const policyJson = (rules: object[]) => ok(JSON.stringify({ rules }));
    const missing = fakeGcloud({
      "compute security-policies list": ok("caelo-production-waf-1a2b\n"),
      "compute security-policies describe": policyJson([{ priority: 1000 }]),
      "compute security-policies rules create 900": ok(),
    });
    expect(await ensureMcpArmorRule({ projectId: "acme", env: "production" }, missing)).toEqual({
      ok: true,
      policy: "caelo-production-waf-1a2b",
      action: "created",
    });
    expect(missing.calls.at(-1)).toContain("--security-policy=caelo-production-waf-1a2b");

    const args = mcpArmorRuleArgs();
    const present = fakeGcloud({
      "compute security-policies list": ok("caelo-production-waf-1a2b\n"),
      "compute security-policies describe": policyJson([{ ...args }]),
    });
    const r = await ensureMcpArmorRule({ projectId: "acme", env: "production" }, present);
    expect(r.ok && r.action).toBe("present");
    expect(present.calls.some((c) => c.includes("rules "))).toBe(false);

    const drifted = fakeGcloud({
      "compute security-policies list": ok("caelo-production-waf-1a2b\n"),
      "compute security-policies describe": policyJson([{ ...args, action: "allow" }]),
      "compute security-policies rules update 900": ok(),
    });
    const d = await ensureMcpArmorRule({ projectId: "acme", env: "production" }, drifted);
    expect(d.ok && d.action).toBe("updated");
  });
});
