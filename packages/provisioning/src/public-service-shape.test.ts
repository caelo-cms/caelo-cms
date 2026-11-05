// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #763 E11 / #1339 — every adapter provisions the public services in
 * the shape of PUBLIC_SERVICE_SHAPE: at zero minimum instances, behind the
 * edge the table names, with a WAF only where the table says so, and the
 * GCP cost table prices what is provisioned. Pure-string checks on the
 * stack programs and the CLI setup modules, like the other stack tests.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupportedProvider } from "./adapter.js";
import { generateDockerCompose } from "./compose.js";
import { GATEWAY_ARMOR_BILLED_RULES } from "./gateway-edge.js";
import { PUBLIC_SERVICE_SHAPE, type PublicService } from "./public-service-shape.js";
import {
  CLOUD_ARMOR_POLICY_USD,
  CLOUD_ARMOR_RULE_USD,
  estimateGcpCost,
} from "./wizards/gcp-cost.js";

const stack = (provider: SupportedProvider) =>
  readFileSync(resolve(import.meta.dir, `../stacks/${provider}/index.ts`), "utf8");
const src = (file: string) => readFileSync(resolve(import.meta.dir, file), "utf8");

const SERVICES: readonly PublicService[] = ["gateway", "staging-gateway", "mcp-auth-proxy"];

/** The `cloudRunService({ serviceName: "<name>", … })` call of a GCP stack. */
function cloudRunBlock(source: string, name: string): string | null {
  const m = new RegExp(
    `cloudRunService\\(\\{\\s*serviceName: "${name}",([\\s\\S]*?)\\n\\s*\\}\\)`,
  ).exec(source);
  return m?.[1] ?? null;
}

describe("E11: one public-service shape for every provider", () => {
  for (const provider of ["gcp", "gcp-firebase"] as const) {
    describe(provider, () => {
      const source = stack(provider);
      for (const service of SERVICES) {
        const shape = PUBLIC_SERVICE_SHAPE[provider][service];
        it(`${service}: ${shape.owner.kind}-owned at zero minimum instances`, () => {
          if (shape.owner.kind === "stack") {
            const block = cloudRunBlock(source, service);
            expect(block).not.toBeNull();
            // The gateway's minimum is the §11.B knob, which defaults to 0.
            const min = service === "gateway" ? "gatewayMinInstances" : "0";
            expect(block).toContain(`minInstances: ${min},`);
            expect(source).toContain(
              `const gatewayMinInstances = Number.parseInt(cfg.get("gatewayMinInstances") ?? "0", 10);`,
            );
          } else if (shape.owner.kind === "cli") {
            const setup = src(shape.owner.module);
            expect(setup).toContain('"--min-instances=0"');
            expect(setup).toContain('"--cpu-throttling"');
            // The stack does not declare what the CLI owns.
            expect(cloudRunBlock(source, service)).toBeNull();
          } else {
            throw new Error(`${provider} ${service}: unexpected owner ${shape.owner.kind}`);
          }
        });
      }
      it(`a WAF only where the table says so (${provider})`, () => {
        const anyWaf = SERVICES.some((s) => PUBLIC_SERVICE_SHAPE[provider][s].waf !== "none");
        if (anyWaf) {
          expect(source).toContain("new gcp.compute.SecurityPolicy(");
          expect(source).toMatch(/function gatewayBackend\([\s\S]*?securityPolicy: wafPolicy\.id/);
        } else {
          // E3: the cheap setup has no load balancer and no WAF.
          expect(source).not.toContain("SecurityPolicy");
          expect(source).not.toContain("gcp.compute.URLMap");
          expect(source).not.toContain("BackendService(");
        }
      });
    });
  }

  it("self-hosted runs every public service in Compose", () => {
    const compose = generateDockerCompose({
      domain: "acme.com",
      postgresPassword: "pw",
      rolePasswords: { admin: "a", public: "b", publicStaging: "ps" },
      caeloSecretKek: "0".repeat(64),
      dbTlsServerCertSha256: "ab".repeat(32),
      internalSecret: "i".repeat(48),
      stagingHost: "staging.acme.com",
      stagingGateSecret: "g".repeat(64),
      diskSize: "20Gi",
      ports: { http: 80, https: 443 },
      project: "caelo-acme-com",
      images: {
        mode: "release" as const,
        admin: `ghcr.io/caelo-cms/admin@sha256:${"a".repeat(64)}`,
        gateway: `ghcr.io/caelo-cms/gateway@sha256:${"b".repeat(64)}`,
        "mcp-auth-proxy": `ghcr.io/caelo-cms/mcp-auth-proxy@sha256:${"c".repeat(64)}`,
      },
    });
    for (const service of SERVICES) {
      const owner = PUBLIC_SERVICE_SHAPE["self-hosted"][service].owner;
      if (owner.kind !== "compose") throw new Error(`self-hosted ${service} is not in Compose`);
      expect(compose).toContain(`\n  ${owner.service}:\n`);
    }
  });

  it("aws refuses honestly until #749: no public service, the gap named", () => {
    const source = stack("aws");
    for (const service of SERVICES) {
      expect(PUBLIC_SERVICE_SHAPE.aws[service].owner).toEqual({ kind: "refused", issue: "#749" });
    }
    expect(source).not.toContain("new aws.ecs.Service(");
    expect(source).not.toContain("new aws.ecs.TaskDefinition(");
    expect(source).toContain("FIXME(issue #749)");
  });

  it("azure: the gateway scales to zero by default, the proxy always; staging refused until #750", () => {
    const source = stack("azure");
    expect(source).toContain(
      `const gatewayMinInstances = Number.parseInt(cfg.get("gatewayMinInstances") ?? "0", 10);`,
    );
    expect(source).toMatch(/serviceName: "gateway",[\s\S]*?minReplicas: gatewayMinInstances,/);
    expect(source).toMatch(/serviceName: "mcp-auth-proxy",[\s\S]*?isolated: true,/);
    expect(source).toContain("minReplicas: args.isolated ? 0 :");
    expect(PUBLIC_SERVICE_SHAPE.azure["staging-gateway"].owner).toEqual({
      kind: "refused",
      issue: "#750",
    });
    expect(source).not.toContain('serviceName: "staging-gateway"');
    expect(source).not.toContain("WebApplicationFirewallPolicy");
  });
});

describe("the GCP cost table prices every provisioned public service (§11.C)", () => {
  for (const provider of ["gcp", "gcp-firebase"] as const) {
    const { lines } = estimateGcpCost({
      cloudSqlTier: "db-f1-micro",
      cloudSqlHa: false,
      adminMinInstances: 0,
      gatewayMinInstances: 0,
      wafAdaptiveProtection: false,
      provider,
      region: "europe-west1",
    });
    const names = lines.map((l) => l.name);
    it(`${provider}: a Cloud Run line per public service`, () => {
      expect(names.some((n) => /Cloud Run (data )?gateway$/.test(n))).toBe(true);
      expect(names).toContain("Cloud Run staging gateway");
      expect(names).toContain("Cloud Run MCP-Auth-Proxy");
    });
    it(`${provider}: Cloud Armor lines exactly where the table has a WAF`, () => {
      const armor = lines.filter((l) => l.name.includes("Cloud Armor"));
      const wafs = SERVICES.filter((s) => PUBLIC_SERVICE_SHAPE[provider][s].waf === "cloud-armor");
      if (wafs.length === 0) {
        expect(armor).toEqual([]);
        expect(names.some((n) => n.startsWith("Load balancer"))).toBe(false);
        return;
      }
      // Two policies: the gateways' (shared with the staging gateway) and the proxy's.
      expect(armor.map((l) => l.monthlyUsd)).toEqual([
        CLOUD_ARMOR_POLICY_USD + GATEWAY_ARMOR_BILLED_RULES * CLOUD_ARMOR_RULE_USD,
        CLOUD_ARMOR_POLICY_USD + 2 * CLOUD_ARMOR_RULE_USD,
      ]);
    });
  }
});
