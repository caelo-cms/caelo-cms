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

/** Secret names of the stack's accessor loop (`for (const made of [{ name: "x", made: … }])`). */
function accessorLoopSecrets(src: string): string[] {
  const loop = src.match(/for \(const made of \[([\s\S]*?)\]\)/)?.[1] ?? "";
  return [...loop.matchAll(/name: "([^"]+)", made:/g)].map((m) => m[1] as string);
}

const MEMBER_EXPR: Record<IamInvariant["member"], string> = {
  "run-sa": "runSa.email",
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

/**
 * Plain env vars set in a stack outside the contract. Only the secrets the
 * Secret Manager follow-up moves may stay — everything else belongs in
 * adminEnvContract / gatewayEnvContract so upgrade applies it too.
 */
const ENV_OUTSIDE_CONTRACT = new Set([
  "ADMIN_DATABASE_URL",
  "PUBLIC_ADMIN_DATABASE_URL",
  "PUBLIC_DATABASE_URL",
  "CAELO_SECRET_KEK",
]);

describe.each(["gcp", "gcp-firebase"] as const)("%s stack ↔ upgrade parity", (provider) => {
  const src = stack(provider);
  const declared = declaredBindings(src);
  const invariants = stackIamInvariants(provider);
  const exempt = STACK_IAM_NOT_ENSURED[provider];

  it("finds the stack's IAM resources (guards the parser)", () => {
    expect(declared.length).toBeGreaterThan(8);
  });

  it("every IAM binding the stack declares is ensured by upgrade or exempted with a reason", () => {
    const secrets = accessorLoopSecrets(src);
    expect(secrets.length).toBeGreaterThan(0);
    const unhandled: string[] = [];
    for (const d of declared) {
      const names = d.name === "*-binding" ? secrets.map((s) => `${s}-binding`) : [d.name];
      for (const name of names) {
        if (exempt[name]) continue;
        const inv = invariants.find((i) => i.stackResource === name);
        if (!inv) {
          unhandled.push(`${name} (${d.type})`);
          continue;
        }
        const role = d.body.match(/role: "([^"]+)"/)?.[1];
        expect(`${name}: ${role}`).toBe(`${name}: ${inv.role}`);
        expect(d.body).toContain(MEMBER_EXPR[inv.member]);
        const target = targetExpr(inv);
        expect(d.type).toMatch(target.type);
        if (target.ref) expect(d.body).toContain(target.ref);
      }
    }
    expect(unhandled).toEqual([]);
  });

  it("every invariant and exemption names a binding the stack still declares", () => {
    const secrets = accessorLoopSecrets(src);
    const names = new Set(
      declared.flatMap((d) =>
        d.name === "*-binding" ? secrets.map((s) => `${s}-binding`) : [d.name],
      ),
    );
    for (const inv of invariants) expect(names).toContain(inv.stackResource);
    for (const key of Object.keys(exempt)) expect(names).toContain(key);
  });

  it("builds the admin + gateway env from the shared contracts", () => {
    expect(src).toMatch(/serviceName: "admin",[\s\S]*?contractEnv: adminEnvContract\(/);
    expect(src).toMatch(/serviceName: "gateway",[\s\S]*?contractEnv: gatewayEnvContract\(/);
    expect(src).toContain("...args.contractEnv,");
  });

  it("sets no plain env var outside the contract", () => {
    const envNames = [...src.matchAll(/\{\s*name: "([A-Z][A-Z0-9_]+)"/g)].map((m) => m[1]);
    expect(envNames.length).toBeGreaterThan(0);
    expect(envNames.filter((n) => !ENV_OUTSIDE_CONTRACT.has(n as string))).toEqual([]);
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
