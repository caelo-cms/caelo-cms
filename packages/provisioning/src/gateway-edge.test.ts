// SPDX-License-Identifier: MPL-2.0

/**
 * #1339 — the gateway's Cloud Armor rules (gateway-edge.ts): their order,
 * the stack and the converge applying the same rules, and the converge
 * bringing an install with the old single rate rule up to them.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureGatewayArmorRules } from "./gateway-armor.js";
import {
  CREDENTIAL_PATH_PATTERN,
  DEFAULT_RULE_PRIORITY,
  GATEWAY_ARMOR_BILLED_RULES,
  GATEWAY_ARMOR_RULES,
  gatewayArmorRuleArgs,
  isGatewayArmorRule,
  type LiveGatewayArmorRule,
} from "./gateway-edge.js";
import type { GcloudResult } from "./gcloud.js";
import { MCP_ARMOR_RULE } from "./remote-mcp-edge.js";

const ok = (stdout = ""): GcloudResult => ({ ok: true, stdout, stderr: "", exitCode: 0 });

/** A rule as `gcloud compute security-policies describe --format=json` returns it. */
function live(args: ReturnType<typeof gatewayArmorRuleArgs>[number]): LiveGatewayArmorRule {
  return JSON.parse(JSON.stringify(args)) as LiveGatewayArmorRule;
}

/** A fake gcloud holding one policy with `rules`, recording every call. */
function fakeGcloud(rules: LiveGatewayArmorRule[], policies = ["caelo-production-waf-1a2b3c"]) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<GcloudResult> => {
    calls.push(args);
    if (args.includes("list")) return ok(`${policies.join("\n")}\n`);
    if (args.includes("describe")) return ok(JSON.stringify({ rules }));
    return ok();
  };
  return { run, calls };
}

describe("the gateway's Cloud Armor rules (#1339)", () => {
  it("run in a fixed order: credential ban, captcha throttle, the API ban, then the OWASP packs", () => {
    const priorities = GATEWAY_ARMOR_RULES.map((r) => r.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    expect(new Set(priorities).size).toBe(priorities.length);
    // The MCP throttle's priority stays free: the converge of #1328 retires
    // a rule there by its exact shape.
    expect(priorities).not.toContain(MCP_ARMOR_RULE.priority);
    expect(priorities).not.toContain(DEFAULT_RULE_PRIORITY);
    expect(GATEWAY_ARMOR_BILLED_RULES).toBe(GATEWAY_ARMOR_RULES.length + 1);
  });

  it("bans a credential-op flood harder than the plugin's own limits, and only those paths", () => {
    const re = new RegExp(CREDENTIAL_PATH_PATTERN);
    for (const op of ["signup", "login", "request_password_reset", "reset_password"]) {
      expect(re.test(`/api/plugin/auth/${op}`)).toBe(true);
    }
    for (const p of [
      "/api/plugin/auth/me",
      "/api/plugin/auth/logout",
      "/api/plugin/auth/../auth/login",
      "/api/plugin/auth/%6cogin",
      "/api/plugin/auth/login/x",
    ]) {
      expect(re.test(p)).toBe(false);
    }
    const credential = GATEWAY_ARMOR_RULES[0];
    expect(credential?.kind === "rate" && credential.count).toBe(30);
  });

  it("keeps staged pages out of the general ban: it matches /api/ paths only", () => {
    const general = GATEWAY_ARMOR_RULES.find((r) => r.priority === 1001);
    expect(general?.expression).toBe("request.path.contains('/api/')");
    for (const r of GATEWAY_ARMOR_RULES) expect(r.expression).not.toContain("srcIpRanges");
  });

  it("are what the gcp stack declares", () => {
    const src = readFileSync(resolve(import.meta.dir, "../stacks/gcp/index.ts"), "utf8");
    expect(src).toContain("rules: gatewayArmorRuleArgs(),");
    expect(src).not.toContain("evaluatePreconfiguredWaf(");
    const args = gatewayArmorRuleArgs();
    expect(args.at(-1)?.priority).toBe(DEFAULT_RULE_PRIORITY);
    expect(args.at(-1)?.action).toBe("allow");
  });

  it("recognises a live rule only when it is exactly the spec", () => {
    const args = gatewayArmorRuleArgs();
    GATEWAY_ARMOR_RULES.forEach((spec, i) => {
      const rule = live(args[i] as (typeof args)[number]);
      expect(isGatewayArmorRule(rule, spec)).toBe(true);
      expect(isGatewayArmorRule({ ...rule, action: "allow" }, spec)).toBe(false);
      expect(isGatewayArmorRule({ ...rule, match: { expr: { expression: "true" } } }, spec)).toBe(
        false,
      );
    });
  });
});

describe("ensureGatewayArmorRules (the converge, contract 21)", () => {
  const target = { projectId: "acme", env: "production" };

  it("changes nothing when every rule is in place", async () => {
    const { run, calls } = fakeGcloud(gatewayArmorRuleArgs().map(live));
    const r = await ensureGatewayArmorRules(target, { run });
    expect(r).toEqual({ ok: true, policy: "caelo-production-waf-1a2b3c", done: [] });
    expect(calls.some((c) => c.includes("create") || c.includes("delete"))).toBe(false);
  });

  it("brings the old policy (one source-IP ban, untuned OWASP packs) up to the rules", async () => {
    const old: LiveGatewayArmorRule[] = [
      {
        priority: 1000,
        action: "rate_based_ban",
        match: { versionedExpr: "SRC_IPS_V1", config: { srcIpRanges: ["*"] } },
        rateLimitOptions: {
          rateLimitThreshold: { count: 100, intervalSec: 60 },
          conformAction: "allow",
          exceedAction: "deny(429)",
          enforceOnKey: "IP",
          banDurationSec: 600,
        },
      },
      {
        priority: 2000,
        action: "deny(403)",
        match: { expr: { expression: "evaluatePreconfiguredWaf('sqli-v33-stable')" } },
      },
      {
        priority: 2001,
        action: "deny(403)",
        match: { expr: { expression: "evaluatePreconfiguredWaf('xss-v33-stable')" } },
      },
      // An Owner's own rule stays.
      {
        priority: 5000,
        action: "deny(403)",
        match: { expr: { expression: "origin.region_code == 'XX'" } },
      },
    ];
    const { run, calls } = fakeGcloud(old);
    const r = await ensureGatewayArmorRules(target, { run });
    expect(r.ok).toBe(true);
    const writes = calls.filter((c) => c.includes("rules")).map((c) => `${c[3]} ${c[4]}`);
    // Updated in place (never a moment without the rule); the old catch-all
    // goes only after every new rule is in.
    expect(writes).toEqual([
      "create 800",
      "create 810",
      "create 1001",
      "update 2000",
      "update 2001",
      "delete 1000",
    ]);
    const general = calls.find((c) => c[3] === "create" && c[4] === "1001") ?? [];
    expect(general).toContain("--expression=request.path.contains('/api/')");
    expect(general).toContain("--action=rate-based-ban");
    expect(general).toContain("--ban-duration-sec=600");
    expect(general).toContain("--security-policy=caelo-production-waf-1a2b3c");
    const captcha = calls.find((c) => c[3] === "create" && c[4] === "810") ?? [];
    expect(captcha).toContain("--action=throttle");
    expect(captcha.some((a) => a.startsWith("--ban-duration-sec"))).toBe(false);
    expect(calls.some((c) => c.includes("5000"))).toBe(false);
  });

  it("refuses when it cannot tell which policy is the gateway's", async () => {
    for (const policies of [[], ["caelo-production-waf-a", "caelo-production-waf-b"]]) {
      const { run, calls } = fakeGcloud([], policies);
      const r = await ensureGatewayArmorRules(target, { run });
      expect(r.ok).toBe(false);
      expect(calls.some((c) => c.includes("create"))).toBe(false);
    }
  });

  it("keeps the old catch-all ban when a new rule could not be written", async () => {
    const calls: string[][] = [];
    const old = {
      priority: 1000,
      action: "rate_based_ban",
      match: { versionedExpr: "SRC_IPS_V1", config: { srcIpRanges: ["*"] } },
      rateLimitOptions: {
        rateLimitThreshold: { count: 100, intervalSec: 60 },
        conformAction: "allow",
        exceedAction: "deny(429)",
        enforceOnKey: "IP",
        banDurationSec: 600,
      },
    };
    const run = async (args: string[]): Promise<GcloudResult> => {
      calls.push(args);
      if (args.includes("list")) return ok("caelo-production-waf-x\n");
      if (args.includes("describe")) return ok(JSON.stringify({ rules: [old] }));
      if (args[4] === "1001") return { ok: false, stdout: "", stderr: "QUOTA", exitCode: 1 };
      return ok();
    };
    const r = await ensureGatewayArmorRules(target, { run });
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.includes("delete"))).toBe(false);
  });

  it("leaves an Owner's own rule at the old priority alone", async () => {
    const own = {
      priority: 1000,
      action: "rate_based_ban",
      match: { versionedExpr: "SRC_IPS_V1", config: { srcIpRanges: ["203.0.113.0/24"] } },
      rateLimitOptions: {
        rateLimitThreshold: { count: 100, intervalSec: 60 },
        banDurationSec: 600,
      },
    };
    const { run, calls } = fakeGcloud([...gatewayArmorRuleArgs().map(live), own]);
    const r = await ensureGatewayArmorRules(target, { run });
    expect(r).toEqual({ ok: true, policy: "caelo-production-waf-1a2b3c", done: [] });
    expect(calls.some((c) => c.includes("delete"))).toBe(false);
  });

  it("stops at the first failed write and says which rule", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<GcloudResult> => {
      calls.push(args);
      if (args.includes("list")) return ok("caelo-production-waf-x\n");
      if (args.includes("describe")) return ok(JSON.stringify({ rules: [] }));
      return { ok: false, stdout: "", stderr: "PERMISSION_DENIED", exitCode: 1 };
    };
    const r = await ensureGatewayArmorRules(target, { run });
    expect(r).toEqual({
      ok: false,
      error: "create rule 800 on caelo-production-waf-x: PERMISSION_DENIED",
      done: [],
    });
  });
});
