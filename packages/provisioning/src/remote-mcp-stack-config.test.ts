// SPDX-License-Identifier: MPL-2.0

/**
 * #1082 — the remote-MCP identity env has one owner: the stack, which
 * declares it from the config the CLI writes before `up`. These tests pin
 * the config round trip and what a refreshed `pulumi up` / `state migrate`
 * preview would plan for the services' env against an install whose live
 * services carry the vars (the viu.one shape: contract env plus the four /
 * two identity vars gcloud added, in gcloud's order).
 */

import { describe, expect, it } from "bun:test";
import type * as automation from "@pulumi/pulumi/automation";
import {
  adminEnvContract,
  type CloudRunEnvVar,
  databaseUrls,
  gatewayEnvContract,
  parseRemoteMcpIdentityConfig,
  REMOTE_MCP_ENV,
  REMOTE_MCP_IDENTITY_CONFIG,
  type RemoteMcpIdentity,
  remoteMcpIdentityEnv,
  remoteMcpIdentityStackEnv,
  sameRemoteMcpIdentity,
  serializeRemoteMcpIdentity,
} from "./stack-contract.js";
import { applyStackConfig, type StackConfigInputs } from "./wizards/gcp-pulumi.js";

const identity: RemoteMcpIdentity = {
  adminUrl: "https://caelo-production-admin-f89c711-7whkh344ca-ew.a.run.app",
  mcpPublicUrl: "https://caelo-production-gateway-6da3bb0-7whkh344ca-ew.a.run.app",
  iapAudience: "/projects/42/locations/europe-west1/services/caelo-production-admin-f89c711",
  googleOrgDomain: "acme.com",
};

const contractInputs = {
  provider: "gcp-firebase",
  projectId: "viu-one-web",
  env: "production",
  domain: "viu.one",
  region: "europe-west1",
  stagingHost: "staging.viu.one",
  databaseUrls: databaseUrls("10.153.0.3"),
} as const;
const contract = {
  admin: adminEnvContract({
    ...contractInputs,
    firebaseSiteId: "caelo-production-site-eb4697",
    gatewayService: "caelo-production-gateway-6da3bb0",
  }),
  gateway: gatewayEnvContract(contractInputs),
};

/** The env a stack declares for one service, given the config value. */
function declared(slug: "admin" | "gateway", config: string | undefined): CloudRunEnvVar[] {
  return [...contract[slug], ...remoteMcpIdentityStackEnv(config)[slug]];
}

/** The live services after an installer run plus its old gcloud post-step: gcloud reorders. */
function live(slug: "admin" | "gateway"): CloudRunEnvVar[] {
  return [...contract[slug], ...remoteMcpIdentityEnv(identity)[slug]].reverse();
}

/**
 * What a refreshed preview plans for `containers.env`: the provider holds it
 * as a set (terraform-provider-google `google_cloud_run_v2_service`), so
 * order is no diff — a var only the live service has is removed, one only
 * the program has is added, a different value is changed.
 */
function envPlan(desired: readonly CloudRunEnvVar[], actual: readonly CloudRunEnvVar[]) {
  const key = (v: CloudRunEnvVar) => JSON.stringify(v);
  const want = new Map(desired.map((v) => [v.name, key(v)]));
  const have = new Map(actual.map((v) => [v.name, key(v)]));
  return {
    removed: [...have.keys()].filter((n) => !want.has(n)).sort(),
    added: [...want.keys()].filter((n) => !have.has(n)).sort(),
    changed: [...want.keys()].filter((n) => have.has(n) && have.get(n) !== want.get(n)).sort(),
  };
}

describe("remote-MCP identity as stack config (#1082)", () => {
  it("round-trips through the config value", () => {
    const raw = serializeRemoteMcpIdentity(identity);
    expect(parseRemoteMcpIdentityConfig(raw)).toEqual(identity);
    const { googleOrgDomain: _d, ...noOrg } = identity;
    expect(parseRemoteMcpIdentityConfig(serializeRemoteMcpIdentity(noOrg))).toEqual(noOrg);
  });

  it("declares nothing while the config is unset (a fresh install's first up)", () => {
    expect(parseRemoteMcpIdentityConfig(undefined)).toBeNull();
    expect(remoteMcpIdentityStackEnv(undefined)).toEqual({ admin: [], gateway: [] });
  });

  it("refuses a corrupt or foreign value loudly instead of dropping the vars", () => {
    expect(() => parseRemoteMcpIdentityConfig("{")).toThrow(REMOTE_MCP_IDENTITY_CONFIG);
    expect(() =>
      parseRemoteMcpIdentityConfig(JSON.stringify({ ...identity, adminUrl: "http://x" })),
    ).toThrow("adminUrl");
    expect(() => parseRemoteMcpIdentityConfig(JSON.stringify({ ...identity, extra: "x" }))).toThrow(
      REMOTE_MCP_IDENTITY_CONFIG,
    );
  });

  it("declares exactly the vars and values upgrade's gcloud roll sets", () => {
    expect(remoteMcpIdentityStackEnv(serializeRemoteMcpIdentity(identity))).toEqual(
      remoteMcpIdentityEnv(identity),
    );
    expect(
      remoteMcpIdentityStackEnv(serializeRemoteMcpIdentity(identity))
        .admin.map((v) => v.name)
        .sort(),
    ).toEqual(Object.values(REMOTE_MCP_ENV).sort());
  });

  it.each(["admin", "gateway"] as const)(
    "%s: with the config the CLI writes, a refreshed plan removes and changes nothing",
    (slug) => {
      const plan = envPlan(declared(slug, serializeRemoteMcpIdentity(identity)), live(slug));
      expect(plan).toEqual({ removed: [], added: [], changed: [] });
    },
  );

  it("without it (the bug), every up strips the vars gcloud set", () => {
    expect(envPlan(declared("admin", undefined), live("admin")).removed).toEqual([
      "CAELO_ADMIN_URL",
      "CAELO_GOOGLE_ORG_DOMAIN",
      "CAELO_IAP_AUDIENCE",
      "CAELO_MCP_PUBLIC_URL",
    ]);
    expect(envPlan(declared("gateway", undefined), live("gateway")).removed).toEqual([
      "CAELO_ADMIN_URL",
      "CAELO_MCP_PUBLIC_URL",
    ]);
  });

  it("compares identities by every var they set", () => {
    expect(sameRemoteMcpIdentity(identity, { ...identity })).toBe(true);
    expect(sameRemoteMcpIdentity(identity, { ...identity, googleOrgDomain: undefined })).toBe(
      false,
    );
    expect(sameRemoteMcpIdentity(identity, null)).toBe(false);
    expect(sameRemoteMcpIdentity(null, null)).toBe(true);
  });
});

describe("applyStackConfig writes the identity (#1082)", () => {
  /** A Stack fake recording the config the CLI sets. */
  function fakeStack() {
    const config: Record<string, string> = {};
    const stack = {
      setAllConfig: async (c: automation.ConfigMap) => {
        for (const [k, v] of Object.entries(c)) config[k] = v.value;
      },
      setConfig: async (k: string, v: automation.ConfigValue) => {
        config[k] = v.value;
      },
      getConfig: async (k: string) => {
        if (!(k in config)) throw new Error(`configuration key '${k}' not found`);
        return { value: config[k] as string };
      },
    } as unknown as automation.Stack;
    return { stack, config };
  }
  const inputs: StackConfigInputs = {
    provider: "gcp-firebase",
    projectId: "viu-one-web",
    domain: "viu.one",
    stagingDomain: "staging.viu.one",
    ownerEmail: "owner@viu.one",
    region: "europe-west1",
    cloudSqlTier: "db-f1-micro",
    cloudSqlHa: false,
    adminMinInstances: 0,
    adminMemory: "2Gi",
    gatewayMinInstances: 0,
    wafAdaptiveProtection: false,
    iapAllowlist: ["owner@viu.one"],
    imageDigests: { admin: "sha256:a", gateway: "sha256:g" },
  };
  const key = `caelo-gcp-firebase:${REMOTE_MCP_IDENTITY_CONFIG}`;

  it("sets the key the stack reads, from the resolved identity", async () => {
    const { stack, config } = fakeStack();
    await applyStackConfig(stack, { ...inputs, remoteMcpIdentity: identity }, []);
    expect(parseRemoteMcpIdentityConfig(config[key])).toEqual(identity);
  });

  it("keeps what an earlier run recorded when the identity could not be read", async () => {
    const { stack, config } = fakeStack();
    config[key] = serializeRemoteMcpIdentity(identity);
    await applyStackConfig(stack, { ...inputs, remoteMcpIdentity: null }, []);
    expect(parseRemoteMcpIdentityConfig(config[key])).toEqual(identity);
  });
});
