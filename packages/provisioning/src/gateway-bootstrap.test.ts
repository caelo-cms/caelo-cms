// SPDX-License-Identifier: MPL-2.0

/**
 * A fresh Google Cloud install deploys the public gateway only onto a
 * migrated database (gateway-bootstrap.ts). Regression: from #767 on, the
 * gateway refuses to boot while its login can CONNECT to cms_admin, the
 * REVOKEs are migrations, and the wizard ran them after the `pulumi up` that
 * created the gateway — so every fresh install failed in that `up` with
 * "the API gateway's database login is not isolated from cms_admin".
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type * as automation from "@pulumi/pulumi/automation";
import { deployOntoMigratedDatabase, readGatewayStart } from "./gateway-bootstrap.js";
import type { GcloudResult } from "./gcloud.js";
import { fixedCloudRunServiceName } from "./stack-contract.js";
import { DEPLOY_GATEWAYS_CONFIG, parseDeployGateways } from "./stack-gateways.js";
import { applyStackConfig, type StackConfigInputs } from "./wizards/gcp-pulumi.js";

const ok = (stdout: string): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });
const failed = (stderr: string): GcloudResult => ({ ok: false, stdout: "", stderr, exitCode: 1 });

/** A gcloud fake: the first matching rule answers; every call is recorded. */
function fakeGcloud(rules: ReadonlyArray<[RegExp, GcloudResult]>) {
  const calls: string[] = [];
  const run = async (args: readonly string[]) => {
    const line = args.join(" ");
    calls.push(line);
    for (const [re, result] of rules) if (re.test(line)) return result;
    throw new Error(`unexpected gcloud call: ${line}`);
  };
  return { run, calls };
}

const TARGET = { provider: "gcp", projectId: "p-1", region: "europe-west1" } as const;

describe("parseDeployGateways", () => {
  it("reads the installer's explicit value", () => {
    expect(parseDeployGateways("true")).toBe(true);
    expect(parseDeployGateways("false")).toBe(false);
  });

  it("declares the gateway on a stack configured before the key existed (every such install is migrated)", () => {
    expect(parseDeployGateways(undefined)).toBe(true);
  });

  it("refuses anything else instead of guessing", () => {
    expect(() => parseDeployGateways("no")).toThrow(DEPLOY_GATEWAYS_CONFIG);
    expect(() => parseDeployGateways("")).toThrow(DEPLOY_GATEWAYS_CONFIG);
  });
});

describe("readGatewayStart", () => {
  it("a project without a gateway service has a gateway that never started", async () => {
    const g = fakeGcloud([[/services list/, ok("")]]);
    expect(await readGatewayStart(TARGET, g.run)).toEqual({ ok: true, start: "never-started" });
    expect(g.calls[0]).toContain("--filter=metadata.name~^caelo-production-gateway");
  });

  it("a gateway whose create failed at its boot check (no ready revision) never started", async () => {
    // The scratch install of 2026-11-04: the service exists, no revision became ready.
    const g = fakeGcloud([
      [/services list/, ok("caelo-production-gateway-1a2b3c4\n")],
      [/describe caelo-production-gateway-1a2b3c4 .*latestReadyRevisionName/, ok("\n")],
    ]);
    expect(await readGatewayStart(TARGET, g.run)).toEqual({ ok: true, start: "never-started" });
  });

  it("a gateway with a ready revision has started, even if its latest revision failed", async () => {
    const g = fakeGcloud([
      [/services list/, ok("caelo-production-gateway-1a2b3c4\n")],
      [/describe/, ok("caelo-production-gateway-1a2b3c4-00007-xyz\n")],
    ]);
    expect(await readGatewayStart(TARGET, g.run)).toEqual({ ok: true, start: "started" });
  });

  it("looks for the data gateway on gcp-firebase, not the MCP-Auth-Proxy that kept the gateway's name", async () => {
    const g = fakeGcloud([[/services list/, ok("")]]);
    await readGatewayStart({ ...TARGET, provider: "gcp-firebase" }, g.run);
    expect(g.calls[0]).toContain("--filter=metadata.name~^caelo-production-data-gateway");
  });

  it("fails loudly when the services cannot be read — no guess either way", async () => {
    const list = fakeGcloud([[/services list/, failed("PERMISSION_DENIED: run.services.list")]]);
    const r = await readGatewayStart(TARGET, list.run);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("PERMISSION_DENIED");

    const describe = fakeGcloud([
      [/services list/, ok("caelo-production-gateway-1a2b3c4\n")],
      [/describe/, failed("boom")],
    ]);
    const d = await readGatewayStart(TARGET, describe.run);
    expect(d.ok).toBe(false);
  });
});

describe("deployOntoMigratedDatabase — the install order", () => {
  function recorder() {
    const steps: string[] = [];
    return {
      steps,
      deps: {
        up: async (deployGateways: boolean) => {
          steps.push(`up(deployGateways=${deployGateways})`);
        },
        prepareDatabase: async () => {
          steps.push("isolate + migrate");
        },
      },
    };
  }

  it("a gateway that never started: up without it, migrate, then up with it", async () => {
    const r = recorder();
    expect(await deployOntoMigratedDatabase("never-started", r.deps)).toEqual({
      databasePrepared: true,
    });
    expect(r.steps).toEqual([
      "up(deployGateways=false)",
      "isolate + migrate",
      "up(deployGateways=true)",
    ]);
  });

  it("a gateway that has started keeps the order every existing install had", async () => {
    const r = recorder();
    expect(await deployOntoMigratedDatabase("started", r.deps)).toEqual({
      databasePrepared: false,
    });
    expect(r.steps).toEqual(["up(deployGateways=true)"]);
  });

  it("never deploys the gateway when the migrations fail", async () => {
    const steps: boolean[] = [];
    await expect(
      deployOntoMigratedDatabase("never-started", {
        up: async (d) => {
          steps.push(d);
        },
        prepareDatabase: async () => {
          throw new Error("migrate-admin-exec failed");
        },
      }),
    ).rejects.toThrow("migrate-admin-exec");
    expect(steps).toEqual([false]);
  });
});

describe("applyStackConfig — deployGateways", () => {
  const inputs: StackConfigInputs = {
    provider: "gcp",
    projectId: "p-1",
    domain: "example.com",
    stagingDomain: "staging.example.com",
    ownerEmail: "o@example.com",
    region: "europe-west1",
    cloudSqlTier: "db-f1-micro",
    cloudSqlHa: false,
    adminMinInstances: 0,
    adminMemory: "2Gi",
    gatewayMinInstances: 0,
    wafAdaptiveProtection: false,
    iapAllowlist: ["user:o@example.com"],
    imageDigests: { admin: "sha256:a", gateway: "sha256:g", "mcp-auth-proxy": "sha256:m" },
    deployGateways: false,
  };

  it.each([false, true])("writes %p as the stack's config before every up", async (value) => {
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
    await applyStackConfig(stack, { ...inputs, deployGateways: value }, []);
    expect(config[`caelo-gcp:${DEPLOY_GATEWAYS_CONFIG}`]).toBe(String(value));
  });
});

/** The resources a stack program declares under Pulumi mocks (src/__tests__/stack-under-mocks.ts). */
function declaredBy(
  provider: "gcp" | "gcp-firebase",
  deployGateways: "true" | "false",
): { type: string; name: string; cloudName?: string }[] {
  const config = {
    domain: "example.com",
    ownerEmail: "o@example.com",
    project: "p-1",
    region: "europe-west1",
    secretReplication: "regional",
    [DEPLOY_GATEWAYS_CONFIG]: deployGateways,
  };
  const r = Bun.spawnSync(
    [
      process.execPath,
      resolve(import.meta.dir, "__tests__", "stack-under-mocks.ts"),
      provider,
      JSON.stringify(config),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) throw new Error(`stack-under-mocks ${provider}: ${r.stderr.toString()}`);
  return r.stdout
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; name: string; cloudName?: string });
}

const SERVICE = "gcp:cloudrunv2/service:Service";

describe("gcp stack — the first up declares no gateway (Pulumi mocks)", () => {
  // Everything that serves or routes visitor traffic to the gateway: the URL
  // map goes with it, because the stack ignores its path rules after creation.
  const GATEWAY_CHAIN = [
    `${SERVICE}::caelo-production-gateway`,
    "gcp:compute/regionNetworkEndpointGroup:RegionNetworkEndpointGroup::caelo-production-gateway-neg",
    "gcp:compute/backendService:BackendService::caelo-production-gateway-backend",
    "gcp:compute/uRLMap:URLMap::caelo-production-url-map",
    "gcp:compute/targetHttpsProxy:TargetHttpsProxy::caelo-production-https-proxy",
    "gcp:compute/globalForwardingRule:GlobalForwardingRule::caelo-production-https-fwd",
  ];
  const keys = (d: ReturnType<typeof declaredBy>) => d.map((r) => `${r.type}::${r.name}`);

  it("withholds the gateway and its route, but declares what the migrations need", () => {
    const first = keys(declaredBy("gcp", "false"));
    for (const k of GATEWAY_CHAIN) expect(first).not.toContain(k);
    for (const k of [
      `${SERVICE}::caelo-production-admin`,
      "gcp:sql/databaseInstance:DatabaseInstance::caelo-production-pg",
      "gcp:sql/database:Database::caelo-production-cms-admin-db",
      "gcp:sql/database:Database::caelo-production-cms-public-db",
      "gcp:sql/database:Database::caelo-production-cms-public-staging-db",
      "gcp:sql/user:User::caelo-production-pg-public",
      "gcp:sql/user:User::caelo-production-pg-public-staging",
    ]) {
      expect(first).toContain(k);
    }
  });

  it("declares all of it once the database is migrated — and adds nothing else", () => {
    const first = keys(declaredBy("gcp", "false"));
    const full = keys(declaredBy("gcp", "true"));
    for (const k of GATEWAY_CHAIN) expect(full).toContain(k);
    expect(full.filter((k) => !first.includes(k)).sort()).toEqual([...GATEWAY_CHAIN].sort());
  });
});

describe("gcp-firebase stack — the first up declares no data gateway (Pulumi mocks)", () => {
  const dataGateway = fixedCloudRunServiceName("gcp-firebase", "production", "gateway");
  const isDataGateway = (r: { type: string; cloudName?: string }) =>
    r.type === SERVICE && r.cloudName === dataGateway;

  it("withholds the data gateway and its bindings, keeps the admin and the MCP-Auth-Proxy", () => {
    const first = declaredBy("gcp-firebase", "false");
    expect(first.filter(isDataGateway)).toEqual([]);
    expect(first.map((r) => r.name)).not.toContain("caelo-production-data-gateway-public-invoker");
    expect(first.map((r) => r.name)).not.toContain(
      "caelo-production-data-gateway-viewer-for-admin-sa",
    );
    expect(first.filter((r) => r.type === SERVICE).length).toBe(2);
  });

  it("declares it once the database is migrated", () => {
    const full = declaredBy("gcp-firebase", "true");
    expect(full.filter(isDataGateway).length).toBe(1);
    expect(full.map((r) => r.name)).toContain("caelo-production-data-gateway-public-invoker");
  });
});

describe("the installer wires the order (wizards/gcp.ts)", () => {
  const src = readFileSync(resolve(import.meta.dir, "wizards", "gcp.ts"), "utf8");
  const converge = src.slice(src.indexOf("export async function runGcpConverge("));
  const body = converge.slice(0, converge.indexOf("\nasync function ") + 1 || undefined);

  it("runs the first pulumi up through deployOntoMigratedDatabase, with the gateway decided by the live read", () => {
    const firstUp = body.indexOf("stepPulumiUp(");
    expect(body.indexOf("stepReadGatewayStart(")).toBeGreaterThan(-1);
    expect(body.indexOf("deployOntoMigratedDatabase(gatewayStart")).toBeGreaterThan(-1);
    expect(firstUp).toBeGreaterThan(body.indexOf("deployOntoMigratedDatabase(gatewayStart"));
    expect(body.indexOf("stepReadGatewayStart(")).toBeLessThan(firstUp);
  });

  it("every other up keeps the gateway declared", () => {
    const calls = body.split("stepPulumiUp(").slice(1);
    expect(calls.length).toBe(2);
    expect(calls[0]).toMatch(/^installId, \{\s*\.\.\.upOpts,\s*deployGateways,/);
    expect(calls[1]).toMatch(/^installId, \{\s*\.\.\.upOpts,\s*deployGateways: true,/);
  });

  it("isolates the logins and migrates inside prepareDatabase, before the gateway's up", () => {
    const prepare = body.slice(body.indexOf("prepareDatabase: async () => {"));
    const prepareBody = prepare.slice(0, prepare.indexOf("\n    },\n"));
    expect(prepareBody.indexOf("stepPublicRoleIsolation(projectId)")).toBeGreaterThan(-1);
    expect(prepareBody.indexOf("stepMigrations(projectId, region)")).toBeGreaterThan(
      prepareBody.indexOf("stepPublicRoleIsolation(projectId)"),
    );
  });

  it("migrates after the up only when it did not before", () => {
    expect(body).toMatch(
      /if \(!databasePrepared\) \{\s*phase\("Applying database migrations"\);\s*await stepMigrations\(projectId, region\);/,
    );
  });
});
