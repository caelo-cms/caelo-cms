// SPDX-License-Identifier: MPL-2.0

/**
 * The §11.A tools for AI budgets, AI pricing and gateway settings: they are
 * registered, approval-gated with the right propose/execute pair, reachable
 * on the Power-MCP surface (flagged gated), and their schemas accept the
 * shapes the apply ops accept and nothing else. Telemetry consent has no
 * tool on purpose (see telemetry.set's `Why human-only`).
 */

import { describe, expect, it } from "bun:test";
import { OperationRegistry } from "@caelo-cms/query-api";
import { powerToolCatalogue } from "../../../ops/security/mcp_power.js";
import { registerAdminOps } from "../../../register.js";
import { buildApprovalPreview } from "../../chat-runner/approval.js";
import { preflightGatedCall } from "../../chat-runner/approval-preflight.js";
import { createDefaultToolRegistry } from "../index.js";
import {
  proposeRotateGatewayCookieSecretTool,
  proposeSetAiBudgetTool,
  proposeSetAiPricingTool,
  proposeSetGatewaySettingsTool,
  proposeSetPluginAiCostCapTool,
  proposeSetTranslationModelTool,
} from "../propose-owner-settings.js";

const GATED = {
  propose_set_ai_budget: "owner_settings.propose_set_ai_budget",
  propose_set_ai_pricing: "owner_settings.propose_set_ai_pricing",
  propose_set_gateway_settings: "owner_settings.propose_set_gateway_settings",
  propose_set_translation_model: "owner_settings.propose_set_translation_model",
  propose_set_plugin_ai_cost_cap: "owner_settings.propose_set_plugin_ai_cost_cap",
  propose_rotate_gateway_cookie_secret: "owner_settings.propose_rotate_gateway_cookie_secret",
} as const;
const READS = ["get_ai_budgets", "list_ai_pricing", "get_gateway_settings"];

const tools = createDefaultToolRegistry();

describe("owner-settings tools — registration + gate", () => {
  for (const [name, proposeOp] of Object.entries(GATED)) {
    it(`${name} is gated on ${proposeOp} → owner_settings.execute_proposal`, () => {
      const t = tools.catalogue().find((x) => x.name === name);
      expect(t?.approvalMode).toBe("user-approval");
      expect(t?.gated).toEqual({
        proposeOp,
        executeOp: "owner_settings.execute_proposal",
        pendingQueuePath: "/security/owner-settings/pending",
      });
    });
  }

  it("read companions are registered and NOT gated", () => {
    for (const name of READS) {
      const t = tools.catalogue().find((x) => x.name === name);
      expect(t).toBeDefined();
      expect(t?.gated).toBeUndefined();
    }
  });

  it("every gated tool and read companion appears on the Power-MCP catalogue; the proposals flagged gated", () => {
    const power = powerToolCatalogue(tools);
    for (const name of Object.keys(GATED)) {
      expect(power.find((t) => t.name === name)?.gated).toBe(true);
    }
    for (const name of READS) expect(power.some((t) => t.name === name)).toBe(true);
  });

  it("telemetry consent deliberately has no AI tool", () => {
    expect(tools.catalogue().some((t) => t.name.includes("telemetry"))).toBe(false);
  });
});

describe("owner-settings tools — plugin AI cap + cookie secret schemas", () => {
  it("plugin AI cap: a slug and a non-negative integer or null; nothing else", () => {
    const schema = proposeSetPluginAiCostCapTool.schema;
    expect(schema.safeParse({ pluginSlug: "forms", capMicrocents: 500_000_000 }).success).toBe(
      true,
    );
    expect(schema.safeParse({ pluginSlug: "forms", capMicrocents: null }).success).toBe(true);
    expect(schema.safeParse({ pluginSlug: "forms", capMicrocents: -1 }).success).toBe(false);
    expect(schema.safeParse({ pluginSlug: "forms", capMicrocents: 1.5 }).success).toBe(false);
    expect(
      schema.safeParse({ pluginId: "11111111-1111-4111-8111-111111111111", capMicrocents: 1 })
        .success,
    ).toBe(false);
  });

  it("cookie-secret rotation needs a real reason and takes no secret", () => {
    const schema = proposeRotateGatewayCookieSecretTool.schema;
    expect(schema.safeParse({ reason: "leaked in a public backup" }).success).toBe(true);
    expect(schema.safeParse({ reason: "x" }).success).toBe(false);
    expect(schema.safeParse({ reason: "leaked in a backup", secret: "abc" }).success).toBe(false);
  });
});

describe("owner-settings tools — schemas", () => {
  it("budget: accepts several cells (warnAtPct optional), rejects a repeated cell", () => {
    const ok = proposeSetAiBudgetTool.schema.safeParse({
      budgets: [
        { scope: "session", operationType: "text", capMicrocents: 1_000_000_000 },
        { scope: "day-global", operationType: "image", capMicrocents: null },
      ],
    });
    expect(ok.success).toBe(true);
    const cell = { scope: "session", operationType: "text", capMicrocents: 1 };
    expect(proposeSetAiBudgetTool.schema.safeParse({ budgets: [cell, cell] }).success).toBe(false);
    expect(
      proposeSetAiBudgetTool.schema.safeParse({
        budgets: [{ scope: "session", operationType: "text", capMicrocents: -1 }],
      }).success,
    ).toBe(false);
  });

  it("pricing: accepts cache-write + window, rejects an inverted window and unknown keys", () => {
    const row = {
      provider: "anthropic",
      model: "claude-x",
      operationType: "text",
      inputMicrocents: 300_000,
      outputMicrocents: 1_500_000,
      cachedMicrocents: 30_000,
      cacheCreationMicrocents: 375_000,
      validFrom: "2026-01-01T00:00:00Z",
      validTo: "2026-12-31T00:00:00Z",
    };
    expect(proposeSetAiPricingTool.schema.safeParse({ rows: [row] }).success).toBe(true);
    expect(
      proposeSetAiPricingTool.schema.safeParse({
        rows: [{ ...row, validFrom: "2027-01-01T00:00:00Z" }],
      }).success,
    ).toBe(false);
    expect(
      proposeSetAiPricingTool.schema.safeParse({ rows: [{ ...row, apiKey: "x" }] }).success,
    ).toBe(false);
  });

  it("gateway: a partial patch is valid, an empty or unknown-key patch is not", () => {
    const s = proposeSetGatewaySettingsTool.schema;
    expect(s.safeParse({ captchaProvider: "turnstile" }).success).toBe(true);
    expect(s.safeParse({}).success).toBe(false);
    expect(s.safeParse({ cookieSecret: "x" }).success).toBe(false);
    expect(s.safeParse({ maxBodyBytes: 10 }).success).toBe(false);
  });

  it("translation model: a model id or null, nothing else (the provider is the active one)", () => {
    const s = proposeSetTranslationModelTool.schema;
    expect(s.safeParse({ model: "claude-haiku-4-5" }).success).toBe(true);
    expect(s.safeParse({ model: null }).success).toBe(true);
    expect(s.safeParse({}).success).toBe(false);
    expect(s.safeParse({ model: "x", name: "openai" }).success).toBe(false);
  });

  it("every description names the approval gate and the units the model must use", () => {
    expect(proposeSetAiBudgetTool.description).toContain("APPROVAL-GATED");
    expect(proposeSetAiBudgetTool.description).toContain("1000000000");
    expect(proposeSetAiPricingTool.description).toContain("PER 1K TOKENS");
    expect(proposeSetGatewaySettingsTool.description).toContain("ONLY the settings that change");
  });

  it("the cookie-rotation approval card says every visitor is logged out, irreversibly", () => {
    const card = buildApprovalPreview("propose_rotate_gateway_cookie_secret", {
      reason: "the secret was printed in a CI log",
    });
    expect(card).toContain("logged out");
    expect(card).toContain("cannot be undone");
    expect(card).toContain("reason: the secret was printed in a CI log");
  });
});

describe("owner-settings tools — preflight before the card", () => {
  const ops = new OperationRegistry();
  registerAdminOps(ops);

  it("a payload the propose op would reject never reaches the operator", () => {
    const rejection = preflightGatedCall(tools, ops, "propose_set_gateway_settings", {});
    expect(rejection?.reason).toContain("owner_settings.propose_set_gateway_settings");
  });

  it("a valid payload passes preflight", () => {
    expect(
      preflightGatedCall(tools, ops, "propose_set_gateway_settings", { captchaProvider: "pow" }),
    ).toBeNull();
  });
});
