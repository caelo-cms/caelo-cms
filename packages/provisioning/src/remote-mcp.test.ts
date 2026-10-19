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
  applyRemoteMcpIdentityEnv,
  ensureMcpArmorRule,
  type LiveUrlMap,
  planUrlMapPaths,
  type RemoteMcpTarget,
  resolveRemoteMcpIdentity,
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
  GENERATED_SECRET_FORMAT,
  MCP_OAUTH_CLIENT_FILE,
  REMOTE_MCP_ENV,
  remoteMcpIdentity,
  remoteMcpIdentityEnv,
  SERVICE_SECRET_FILES,
  secretFileVolumesTemplate,
  stackIamInvariants,
} from "./stack-contract.js";
import { planRequestTimeout, planSecretFiles } from "./stack-converge.js";

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

  it("gives the admin the audience + public URL and the gateway the admin + public URL", () => {
    const env = remoteMcpIdentityEnv({ adminUrl: "A", mcpPublicUrl: "P", iapAudience: "AUD" });
    expect(env.admin).toEqual([
      { name: REMOTE_MCP_ENV.iapAudience, value: "AUD" },
      { name: REMOTE_MCP_ENV.mcpPublicUrl, value: "P" },
    ]);
    expect(env.gateway).toEqual([
      { name: REMOTE_MCP_ENV.adminUrl, value: "A" },
      { name: REMOTE_MCP_ENV.mcpPublicUrl, value: "P" },
    ]);
    expect(REMOTE_MCP_ENV).toEqual({
      adminUrl: "CAELO_ADMIN_URL",
      mcpPublicUrl: "CAELO_MCP_PUBLIC_URL",
      iapAudience: "CAELO_IAP_AUDIENCE",
    });
  });
});

describe("remote-MCP secrets + IAM (contract)", () => {
  it("names a first-value format for every CLI-generated secret", () => {
    expect(Object.keys(GENERATED_SECRET_FORMAT).sort()).toEqual([...CLI_GENERATED_SECRETS].sort());
  });

  it("starts the OAuth client as the {} placeholder and the seal key as 32 random bytes", () => {
    expect(initialSecretValue("mcp-oauth-client")).toBe("{}");
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
          stackResource: "admin-mcp-oauth-client-version-adder",
          member: "run-sa",
          target: { kind: "secret", name: "mcp-oauth-client" },
          onFailure: "warn",
        }),
      ]);
      const adminReads = stackIamInvariants(provider).filter(
        (i) =>
          i.member === "run-sa" &&
          i.role === "roles/secretmanager.secretAccessor" &&
          i.target.kind === "secret" &&
          i.target.name.startsWith("mcp-oauth"),
      );
      expect(adminReads).toEqual([]);
    }
  });

  it("mounts the OAuth client on the gateway only, at latest, as the file its env names", () => {
    expect(SERVICE_SECRET_FILES.admin).toEqual([]);
    expect(SERVICE_SECRET_FILES.gateway).toEqual([MCP_OAUTH_CLIENT_FILE]);
    expect(secretFileVolumesTemplate("gateway", "production")).toEqual({
      volumes: [
        {
          name: "mcp-oauth-client",
          secret: {
            secret: "caelo-production-mcp-oauth-client",
            items: [{ version: "latest", path: "client.json" }],
          },
        },
      ],
      volumeMounts: [{ name: "mcp-oauth-client", mountPath: "/secrets/mcp-oauth-client" }],
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
    expect(planSecretFiles(empty, [MCP_OAUTH_CLIENT_FILE], "production")).toEqual({
      ok: true,
      flags: [
        "--update-secrets=/secrets/mcp-oauth-client/client.json=caelo-production-mcp-oauth-client:latest",
      ],
      changes: [
        "secret file /secrets/mcp-oauth-client/client.json: (none) → caelo-production-mcp-oauth-client:latest",
      ],
    });
  });

  it("leaves the file the stack (or an earlier upgrade) mounted alone, whatever its volume is called", () => {
    for (const name of ["mcp-oauth-client", "secret-1a2b3c"]) {
      const live = {
        executionEnvironment: null,
        volumes: [
          {
            name,
            secret: {
              secretName: "projects/42/secrets/caelo-production-mcp-oauth-client",
              items: [{ key: "latest", path: "client.json" }],
            },
          },
        ],
        mounts: [{ name, mountPath: "/secrets/mcp-oauth-client" }],
      };
      expect(planSecretFiles(live, [MCP_OAUTH_CLIENT_FILE], "production")).toEqual({
        ok: true,
        flags: [],
        changes: [],
      });
    }
  });

  it("refuses something else mounted where the client belongs (a pinned version included)", () => {
    const live = {
      executionEnvironment: null,
      volumes: [
        {
          name: "v",
          secret: {
            secretName: "caelo-production-mcp-oauth-client",
            items: [{ key: "3", path: "client.json" }],
          },
        },
      ],
      mounts: [{ name: "v", mountPath: "/secrets/mcp-oauth-client" }],
    };
    const plan = planSecretFiles(live, [MCP_OAUTH_CLIENT_FILE], "production");
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toContain("--remove-volume-mount=/secrets/mcp-oauth-client");
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

describe("resolveRemoteMcpIdentity", () => {
  it("gcp-firebase: reads the project number and both services' URLs", async () => {
    const { run } = fakeGcloud({
      "projects describe acme": ok("42\n"),
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
      },
    });
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

describe("applyRemoteMcpIdentityEnv", () => {
  const identity = {
    adminUrl: "https://a.run.app",
    mcpPublicUrl: "https://g.run.app",
    iapAudience: "/projects/42/locations/europe-west1/services/caelo-production-admin-aaa",
  };
  const serviceJson = (env: { name: string; value: string }[]) =>
    ok(JSON.stringify({ spec: { template: { spec: { containers: [{ env }] } } } }));

  it("updates only a service whose vars differ", async () => {
    const { run, calls } = fakeGcloud({
      "run services describe caelo-production-admin-aaa": serviceJson([
        { name: "CAELO_IAP_AUDIENCE", value: identity.iapAudience },
        { name: "CAELO_MCP_PUBLIC_URL", value: identity.mcpPublicUrl },
      ]),
      "run services describe caelo-production-gateway-bbb": serviceJson([]),
      "run services update caelo-production-gateway-bbb": ok(),
    });
    const r = await applyRemoteMcpIdentityEnv(firebase, identity, { run });
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c.startsWith("run services update"))).toEqual([
      "run services update caelo-production-gateway-bbb --region=europe-west1 --project=acme --update-env-vars=CAELO_ADMIN_URL=https://a.run.app,CAELO_MCP_PUBLIC_URL=https://g.run.app --quiet",
    ]);
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

  it("covers exactly the broker's paths; a traversal never borrows the MCP rule", () => {
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
    // Why it matters: the gateway's URL parser resolves such a path to a public write.
    expect(new URL("https://h/api/mcp/%2e%2e/comments/post").pathname).toBe("/api/comments/post");
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
