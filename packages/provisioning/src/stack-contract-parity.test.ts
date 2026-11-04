// SPDX-License-Identifier: MPL-2.0

/**
 * Parity between the Pulumi stacks and `cms-provision upgrade`: everything a
 * stack declares for the admin/gateway env, IAM and the CDN must either come
 * from the shared contract (stack-contract.ts) that upgrade also applies, or
 * be explicitly exempted with a reason. A stack change that adds an env var,
 * an IAM binding or a CDN setting without deciding how existing installs get
 * it fails here.
 *
 * Pure-string checks on the stack programs, like the other stack tests.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CLOUD_RUN_IGNORE_CHANGES,
  type CloudRunSlug,
  type GcpProvider,
  type IamInvariant,
  runtimeSecretBindings,
  STACK_IAM_NOT_ENSURED,
  stackIamInvariants,
} from "./stack-contract.js";
import { imageDigestConfig } from "./wizards/gcp-pulumi.js";

const stack = (provider: GcpProvider) =>
  readFileSync(resolve(import.meta.dir, `../stacks/${provider}/index.ts`), "utf8");

interface DeclaredBinding {
  /** Logical name after `${namePrefix}-`, placeholders written as `*`. */
  readonly name: string;
  readonly type: string;
  readonly body: string;
}

/** Every IAM member/binding/policy resource a stack program declares. */
function declaredBindings(src: string): DeclaredBinding[] {
  const re =
    /new gcp\.([\w.]+(?:IAMMember|IamMember|IAMBinding|IamBinding|IAMPolicy|IamPolicy))\(\s*`\$\{namePrefix\}-([^`]+)`,([\s\S]*?)\n\s*\);/g;
  const out: DeclaredBinding[] = [];
  for (const m of src.matchAll(re)) {
    const [, type = "", rawName = "", body = ""] = m;
    out.push({ type, name: rawName.replace(/\$\{[^}]*\}/g, "*"), body });
  }
  return out;
}

/**
 * The stacks declare the secret accessors in one loop over
 * `runtimeSecretBindings()` — the same list upgrade's invariants come from —
 * named `${namePrefix}-${binding.stackResource}`. The parser sees that as `*`.
 */
const SECRET_LOOP_NAME = "*";
const secretBindingNames = () => runtimeSecretBindings().map((b) => b.stackResource);

const expand = (d: DeclaredBinding) =>
  d.name === SECRET_LOOP_NAME ? secretBindingNames() : [d.name];

const MEMBER_EXPR: Record<IamInvariant["member"], string> = {
  "run-sa": "runSa.email",
  // The secret loop resolves the SA per service through `serviceSa`.
  "gateway-sa": "gatewaySa.email",
  "mcp-auth-proxy-sa": "mcpAuthProxySa.email",
  "staging-gateway-sa": "stagingGatewaySa.email",
  "static-publisher-sa": "staticPublisherSa.email",
  "iap-service-agent": "iapServiceIdentity.email",
  allUsers: 'member: "allUsers"',
};

/** The variable each stack holds a Cloud Run service in. */
const SERVICE_VAR: Record<CloudRunSlug, string> = {
  admin: "adminSvc",
  gateway: "gatewaySvc",
  "mcp-auth-proxy": "mcpAuthProxySvc",
};

function targetExpr(inv: IamInvariant): { type: RegExp; ref?: string } {
  switch (inv.target.kind) {
    case "project":
      return { type: /^projects\.IAMMember$/ };
    case "secret":
      return { type: /^secretmanager\.SecretIamMember$/ };
    case "bucket":
      return { type: /^storage\.BucketIAMMember$/, ref: `bucket: ${inv.target.bucket}Bucket.name` };
    case "run-service":
      return {
        type: /^cloudrunv2\.ServiceIamMember$/,
        ref: `name: ${SERVICE_VAR[inv.target.service]}.name`,
      };
  }
}

describe.each(["gcp", "gcp-firebase"] as const)("%s stack ↔ upgrade parity", (provider) => {
  const src = stack(provider);
  const declared = declaredBindings(src);
  const invariants = stackIamInvariants(provider);
  const exempt = STACK_IAM_NOT_ENSURED[provider];

  it("finds the stack's IAM resources (guards the parser)", () => {
    expect(declared.length).toBeGreaterThan(8);
  });

  it("declares the secret accessors from runtimeSecretBindings(), per service SA", () => {
    const loop = declared.filter((d) => d.name === SECRET_LOOP_NAME);
    expect(loop).toHaveLength(1);
    expect(loop[0]?.type).toBe("secretmanager.SecretIamMember");
    expect(src).toContain("for (const binding of runtimeSecretBindings())");
    expect(loop[0]?.body).toContain("serviceSa[binding.service].email");
    expect(src).toMatch(
      /const serviceSa: Record<CloudRunSlug, [^>]+> = \{\s*admin: runSa,\s*gateway: gatewaySa,/,
    );
    expect(src).toContain("serviceAccount: serviceSa[args.serviceName].email");
  });

  it("every IAM binding the stack declares is ensured by upgrade or exempted with a reason", () => {
    const unhandled: string[] = [];
    for (const d of declared) {
      for (const name of expand(d)) {
        if (exempt[name]) continue;
        const inv = invariants.find((i) => i.stackResource === name);
        if (!inv) {
          unhandled.push(`${name} (${d.type})`);
          continue;
        }
        const role = d.body.match(/role: "([^"]+)"/)?.[1];
        expect(`${name}: ${role}`).toBe(`${name}: ${inv.role}`);
        if (d.name !== SECRET_LOOP_NAME) expect(d.body).toContain(MEMBER_EXPR[inv.member]);
        const target = targetExpr(inv);
        expect(d.type).toMatch(target.type);
        if (target.ref) expect(d.body).toContain(target.ref);
      }
    }
    expect(unhandled).toEqual([]);
  });

  it("#1328 — the MCP-Auth-Proxy's SA reads its two secrets and holds no other role", () => {
    expect(src).toContain("accountId: mcpAuthProxyServiceAccountId(env)");
    expect(src).toMatch(/"mcp-auth-proxy": mcpAuthProxySa,/);
    // No binding but the secret loop names it: no project role, no bucket,
    // no service — the loop gives it exactly serviceSecrets("mcp-auth-proxy").
    expect(declared.filter((d) => d.body.includes("mcpAuthProxySa"))).toEqual([]);
    expect(
      runtimeSecretBindings()
        .filter((b) => b.service === "mcp-auth-proxy")
        .map((b) => b.secret),
    ).toEqual(["mcp-oauth-seal-key", "operator-oauth-client"]);
  });

  it("every invariant and exemption names a binding the stack still declares", () => {
    const names = new Set(declared.flatMap(expand));
    for (const inv of invariants) expect(names).toContain(inv.stackResource);
    for (const key of Object.keys(exempt)) expect(names).toContain(key);
  });

  it("builds the admin + gateway env from the shared contracts", () => {
    // #1254 — plus the pool env of the stack's connection budget: derived
    // from stack config (max_connections, instance counts) an upgrade roll
    // cannot see, so it is stack-owned like the remote-MCP env; a roll
    // never removes a var the contract does not own (planEnvUpdate).
    expect(src).toMatch(
      /serviceName: "admin",[\s\S]*?contractEnv: \[\s*\.\.\.adminEnvContract\([\s\S]*?\.\.\.remoteMcpEnv\.admin,\s*(\/\/[^\n]*\n\s*)?\.\.\.poolBudget\.env\.admin,?\s*\]/,
    );
    // #1328 — the gateway carries no remote-MCP env any more.
    expect(src).toMatch(
      /serviceName: "gateway",[\s\S]*?contractEnv: \[\s*\.\.\.gatewayEnvContract\(envContractInputs\),\s*\.\.\.poolBudget\.env\.gateway,?\s*\]/,
    );
    if (provider === "gcp-firebase") {
      // The proxy: its contract and its identity env, nothing else (#1331:
      // no forward origin any more).
      expect(src).toMatch(
        /serviceName: "mcp-auth-proxy",[\s\S]*?contractEnv: \[\s*\.\.\.mcpAuthProxyEnvContract\(\{ provider: "gcp-firebase", env \}\),\s*\.\.\.remoteMcpEnv\["mcp-auth-proxy"\],?\s*\]/,
      );
      expect(src).not.toContain("INTERIM_FORWARD_ORIGIN");
    } else {
      // gcp: the proxy is CLI-owned (mcp-auth-proxy-setup.ts), not a stack service.
      expect(src).not.toContain('serviceName: "mcp-auth-proxy"');
    }
    // #1330 — the staging gateway is CLI-owned on both (staging-gateway-setup.ts).
    expect(src).not.toContain('serviceName: "staging-gateway"');
    expect(src).toContain("envs: [...args.contractEnv],");
  });

  it("#1082 — declares the remote-MCP identity env from the config the CLI writes", () => {
    // The stack is the vars' one owner: `pulumi up` keeps what the CLI used
    // to add with gcloud after every `up` (and every `up` removed again).
    expect(src).toContain(
      "const remoteMcpEnv = remoteMcpIdentityStackEnv(cfg.get(REMOTE_MCP_IDENTITY_CONFIG));",
    );
    expect(src.match(/remoteMcpEnv(\.\w+|\["[\w-]+"\])/g)?.sort()).toEqual(
      provider === "gcp-firebase"
        ? ["remoteMcpEnv.admin", 'remoteMcpEnv["mcp-auth-proxy"]']
        : ["remoteMcpEnv.admin"],
    );
  });

  it("#1082 — leaves client / clientVersion (who deployed last) to gcloud on both services", () => {
    expect(src.match(/new gcp\.cloudrunv2\.Service\(/g)).toHaveLength(1);
    expect(src).toMatch(
      /new gcp\.cloudrunv2\.Service\([\s\S]*?\.\.\.opts,\s*\/\/[^\n]*\n\s*ignoreChanges: \[\.\.\.CLOUD_RUN_IGNORE_CHANGES\],/,
    );
    expect(CLOUD_RUN_IGNORE_CHANGES).toEqual(["client", "clientVersion"]);
  });

  it("#1328 E13 a — the proxy keeps the gateway's logical resource names, so its service and URL stay", () => {
    if (!src.includes('serviceName: "mcp-auth-proxy"')) return; // the gcp stack: CLI-owned proxy
    // Same URN as before → Pulumi updates the existing service (keeping its
    // auto-generated name and run.app URL) instead of creating a new one.
    expect(src).toMatch(
      /serviceName: "mcp-auth-proxy",\s*resourceName: `\$\{namePrefix\}-gateway`,/,
    );
    expect(src).toMatch(/`\$\{namePrefix\}-gateway-public-invoker`/);
    expect(src).not.toContain("aliases");
  });

  it("mounts the media bucket on the admin, and only there, from the contract upgrade applies", () => {
    // The stack's admin gets adminMediaVolume() — the same volume
    // stack-converge.ts planMediaVolume adds to installs that lack it.
    expect(src).toMatch(
      /serviceName: "admin",[\s\S]*?mediaVolume: adminMediaVolumeTemplate\(adminMediaVolume\(project, env\)\),\n\}\);/,
    );
    expect(src.match(/mediaVolume: adminMediaVolumeTemplate\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/serviceName: "gateway",[^}]*mediaVolume:/);
    // No volume, mount or execution environment besides the contract's.
    expect(src.match(/executionEnvironment:/g)).toHaveLength(1);
    expect(src).toContain("? { executionEnvironment: args.mediaVolume.executionEnvironment }");
    expect(src.match(/volumes:/g)).toHaveLength(1);
    expect(src).toMatch(
      /volumes: \[\s*\.\.\.\(args\.mediaVolume\?\.volumes \?\? \[\]\),\s*\.\.\.secretFileVolumesTemplate\(args\.serviceName, env\)\.volumes,\s*\]/,
    );
    expect(src.match(/volumeMounts:/g)).toHaveLength(1);
    expect(src).toMatch(
      /volumeMounts: \[\s*\.\.\.\(args\.mediaVolume\?\.volumeMounts \?\? \[\]\),\s*\.\.\.secretFileVolumesTemplate\(args\.serviceName, env\)\.volumeMounts,\s*\]/,
    );
  });

  it("#806 — mounts each service's secret files from the contract upgrade applies", () => {
    // secretFileVolumesTemplate(service) is SERVICE_SECRET_FILES — the same
    // table stack-converge.ts planSecretFiles adds to existing installs.
    expect(src).toContain("secretFileVolumesTemplate,");
    expect(src.match(/secretFileVolumesTemplate\(args\.serviceName, env\)/g)).toHaveLength(2);
  });

  it("#806 — gives the MCP-Auth-Proxy the contract's request timeout upgrade applies", () => {
    // #1328 — the long remote-MCP streams are the proxy's; the gateway keeps
    // Cloud Run's default. On gcp the proxy is deployed by the CLI with the
    // same constant (mcp-auth-proxy-setup.ts gcpProxyDeployArgs).
    expect(src).toMatch(/serviceName: "gateway",[\s\S]*?timeout: "300s",/);
    expect(src).not.toContain("GATEWAY_TIMEOUT_SECONDS");
    if (provider === "gcp-firebase") {
      expect(src).toMatch(
        /serviceName: "mcp-auth-proxy",[\s\S]*?timeout: `\$\{MCP_AUTH_PROXY_TIMEOUT_SECONDS\}s`,/,
      );
    }
  });

  it("sets no env var outside the contract (C1: no secret value in a plain var)", () => {
    const envNames = [...src.matchAll(/\{\s*name: "([A-Z][A-Z0-9_]+)"/g)].map((m) => m[1]);
    expect(envNames).toEqual([]);
    expect(src).not.toMatch(/valueSource:/);
  });

  it("builds no database URL with a password in it", () => {
    expect(src).not.toMatch(/:\$\{postgresPassword\}@|\$\{pw\}@/);
    // #1338 — from the instance's DNS name, once its private zone record exists.
    expect(src).toContain(".apply(([host]) => databaseUrls(host))");
  });

  it("serves verify-full TLS: shared server CA, encrypted only, DNS name in the VPC (#1338)", () => {
    expect(src).toContain("serverCaMode: CLOUD_SQL_SERVER_CA_MODE");
    expect(src).toContain("sslMode: CLOUD_SQL_SSL_MODE");
    // The names cloudsql-tls.ts converges and adopt-existing.ts adopts.
    expect(src).toContain("name: cloudSqlDnsZoneName(env)");
    expect(src).toContain("managedZone: cloudSqlDnsZoneName(env)");
    expect(src).toContain('visibility: "private"');
  });

  it("references the CLI-generated secrets by id instead of creating them", () => {
    for (const secret of ["internal-secret", "tool-approval-secret"]) {
      expect(src).toContain(`"${secret}": gcpSecretId(env, "${secret}")`);
      expect(src).not.toContain(`makeSecret("${secret}"`);
    }
  });

  it("names buckets and the run SA with the helpers upgrade uses", () => {
    expect(src).not.toMatch(/name: `\$\{project\}-\$\{namePrefix\}-/);
    expect(src).toContain("accountId: runServiceAccountId(env)");
    expect(src).toContain('name: gcpBucketName(project, env, "media")');
  });

  it("pins images by the config keys upgrade writes back", () => {
    const keys = Object.keys(
      imageDigestConfig(provider, {
        admin: "sha256:a",
        gateway: "sha256:b",
        "mcp-auth-proxy": "sha256:c",
      }),
    );
    expect(keys).toEqual([
      `caelo-${provider}:image-digest-admin`,
      `caelo-${provider}:image-digest-gateway`,
      `caelo-${provider}:image-digest-mcp-auth-proxy`,
    ]);
    // The stack reads `<ns>:image-digest-<service>` through pulumi.Config.
    expect(src).toMatch(/cfg\.get\(`image-digest-\$\{service\}`\)/);
  });
});

describe("gcp stack CDN policy", () => {
  it("comes from the shared constant upgrade ensures", () => {
    const src = stack("gcp");
    expect(src).toContain("cdnPolicy: { ...STATIC_CDN_POLICY }");
    expect(src).not.toMatch(/(clientTtl|maxTtl|defaultTtl):\s*\d/);
  });
});
