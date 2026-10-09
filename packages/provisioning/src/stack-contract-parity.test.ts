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
  "static-publisher-sa": "staticPublisherSa.email",
  "iap-service-agent": "iapServiceIdentity.email",
  allUsers: 'member: "allUsers"',
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
        ref: `name: ${inv.target.service}Svc.name`,
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

  it("every invariant and exemption names a binding the stack still declares", () => {
    const names = new Set(declared.flatMap(expand));
    for (const inv of invariants) expect(names).toContain(inv.stackResource);
    for (const key of Object.keys(exempt)) expect(names).toContain(key);
  });

  it("builds the admin + gateway env from the shared contracts", () => {
    expect(src).toMatch(/serviceName: "admin",[\s\S]*?contractEnv: adminEnvContract\(/);
    expect(src).toMatch(/serviceName: "gateway",[\s\S]*?contractEnv: gatewayEnvContract\(/);
    expect(src).toContain("envs: [...args.contractEnv],");
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
    expect(src).toContain("executionEnvironment: args.mediaVolume.executionEnvironment,");
    expect(src.match(/volumes:/g)).toHaveLength(1);
    expect(src).toContain("volumes: [...args.mediaVolume.volumes],");
    expect(src.match(/volumeMounts:/g)).toHaveLength(1);
    expect(src).toContain("volumeMounts: [...args.mediaVolume.volumeMounts]");
  });

  it("sets no env var outside the contract (C1: no secret value in a plain var)", () => {
    const envNames = [...src.matchAll(/\{\s*name: "([A-Z][A-Z0-9_]+)"/g)].map((m) => m[1]);
    expect(envNames).toEqual([]);
    expect(src).not.toMatch(/valueSource:/);
  });

  it("builds no database URL with a password in it", () => {
    expect(src).not.toMatch(/:\$\{postgresPassword\}@|\$\{pw\}@/);
    expect(src).toContain("sqlInstance.privateIpAddress.apply(databaseUrls)");
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
      imageDigestConfig(provider, { admin: "sha256:a", gateway: "sha256:b" }),
    );
    expect(keys).toEqual([
      `caelo-${provider}:image-digest-admin`,
      `caelo-${provider}:image-digest-gateway`,
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
