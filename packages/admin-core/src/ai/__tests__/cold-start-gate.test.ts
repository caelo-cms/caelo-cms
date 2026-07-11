// SPDX-License-Identifier: MPL-2.0

/**
 * issue #106 (step-13 deviation) — the cold-start gate must give setup
 * instructions that actually work for the install state it detects.
 *
 * The original guidance always told the AI to call `set_theme_tokens` /
 * `set_theme_meta` first. On a fresh install with NO active theme those
 * fail ("no active theme"), so the AI burned two doomed tool calls before
 * inferring it had to create + activate a theme first. The gate now
 * branches: with no active theme it points at propose_create_theme →
 * propose_activate_theme (AI-proposed, operator-approved); with an active
 * seed theme it points at set_theme_tokens (mutate in place).
 *
 * Unit-tested with a fake adapter so the branch logic is pinned without a
 * DB — `checkColdStartGate` only reads `site_defaults.get` +
 * `themes.get_active` through `execute`.
 */

import { describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
import { registerAdminOps } from "../../register.js";
import { checkColdStartGate } from "../tools/_cold-start-gate.js";
import type { ToolContext } from "../tools/dispatch.js";

const registry = new OperationRegistry();
registerAdminOps(registry);

type Theme = {
  origin: "seed" | "ai" | "operator";
  description: string | null;
  tokens?: unknown;
} | null;
type Defaults = { siteName: string | null; sitePurpose: string | null } | null;

/** Fake adapter: returns controlled values for the two reads the gate makes. */
function toolCtxWith(theme: Theme, defaults: Defaults): ToolContext {
  const adapter = {
    runOperation: async (op: { name: string }) => {
      if (op.name === "site_defaults.get") return ok({ defaults });
      if (op.name === "themes.get_active") return ok({ theme });
      return ok({});
    },
  } as unknown as DatabaseAdapter;
  return { adapter, registry } as ToolContext;
}

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "coldstart-unit",
};

describe("checkColdStartGate (issue #106)", () => {
  it("with NO active theme, points the AI at propose_create_theme + propose_activate_theme", async () => {
    const res = await checkColdStartGate(AI, toolCtxWith(null, null), "add_module_to_page");
    expect(res.blocked).toBe(true);
    const content = res.gateResult?.content ?? "";
    expect(content).toContain("no active theme yet");
    expect(content).toContain("propose_create_theme");
    expect(content).toContain("propose_activate_theme");
    // issue #112 — the AI composes the document itself; no preset menu.
    expect(content).toContain("tokens");
    expect(content.toLowerCase()).not.toContain("preset:");
    // Create before activate — must not tell the AI to activate a theme
    // that doesn't exist yet.
    expect(content.indexOf("propose_create_theme")).toBeLessThan(
      content.indexOf("propose_activate_theme"),
    );
  });

  it("with an active SEED theme, points the AI at set_theme_tokens (mutate in place)", async () => {
    const res = await checkColdStartGate(
      AI,
      toolCtxWith({ origin: "seed", description: null }, null),
      "add_module_to_page",
    );
    expect(res.blocked).toBe(true);
    const content = res.gateResult?.content ?? "";
    expect(content).toContain("seed-origin");
    expect(content).toContain("set_theme_tokens");
    // A seed theme exists, so there's nothing to create/activate.
    expect(content).not.toContain("propose_create_theme");
  });

  it("issue #112 — origin alone does NOT clear the gate: evolved but undescribed blocks", async () => {
    const res = await checkColdStartGate(
      AI,
      toolCtxWith(
        { origin: "ai", description: null },
        { siteName: "Caelo", sitePurpose: "An AI-first CMS" },
      ),
      "add_module_to_page",
    );
    expect(res.blocked).toBe(true);
    const content = res.gateResult?.content ?? "";
    expect(content).toContain("no recorded design rationale");
  });

  it("issue #112 — evolved-but-undescribed theme gets set_theme_meta-only guidance (no recompose)", async () => {
    const res = await checkColdStartGate(
      AI,
      toolCtxWith(
        { origin: "operator", description: null },
        { siteName: "Caelo", sitePurpose: "An AI-first CMS" },
      ),
      "add_module_to_page",
    );
    expect(res.blocked).toBe(true);
    const content = res.gateResult?.content ?? "";
    expect(content).toContain("set_theme_meta");
    // The theme already exists and is evolved — the fix is recording
    // the rationale, never re-creating or re-tokening the theme.
    expect(content).not.toContain("propose_create_theme");
    expect(content).not.toContain("set_theme_tokens");
  });

  it("does not block once identity is captured AND the theme is evolved + described", async () => {
    const res = await checkColdStartGate(
      AI,
      toolCtxWith(
        { origin: "ai", description: "Indigo primary for a developer-tools brand" },
        { siteName: "Caelo", sitePurpose: "An AI-first CMS" },
      ),
      "add_module_to_page",
    );
    expect(res.blocked).toBe(false);
  });

  it("bypasses non-AI actors", async () => {
    const human: ExecutionContext = { ...AI, actorKind: "human" };
    const res = await checkColdStartGate(human, toolCtxWith(null, null), "add_module_to_page");
    expect(res.blocked).toBe(false);
  });

  it("always ends with a numbered 'Retry' step naming the tool", async () => {
    const res = await checkColdStartGate(AI, toolCtxWith(null, null), "add_module_to_layout");
    expect(res.gateResult?.content ?? "").toContain("Retry `add_module_to_layout`");
  });

  it("blocks when origin+description are set but color.primary is still grayscale (#149 follow-up)", async () => {
    const res = await checkColdStartGate(
      AI,
      toolCtxWith(
        {
          origin: "ai",
          description: "Dark modern look",
          tokens: { color: { primary: { $type: "color", $value: "#171717" } } },
        },
        { siteName: "Acme", sitePurpose: "SaaS" },
      ),
      "add_module_to_page",
    );
    expect(res.blocked).toBe(true);
    const content = res.gateResult?.content ?? "";
    expect(content).toContain("GRAYSCALE");
    expect(content).toContain("set_theme_tokens");
  });

  it("clears with a chromatic primary (hex) and with unparseable color forms (lenient)", async () => {
    const chromatic = await checkColdStartGate(
      AI,
      toolCtxWith(
        {
          origin: "ai",
          description: "Indigo B2B",
          tokens: { color: { primary: { $type: "color", $value: "#4f46e5" } } },
        },
        { siteName: "Acme", sitePurpose: "SaaS" },
      ),
      "add_module_to_page",
    );
    expect(chromatic.blocked).toBe(false);

    const exotic = await checkColdStartGate(
      AI,
      toolCtxWith(
        {
          origin: "ai",
          description: "Branded",
          tokens: { color: { primary: { $type: "color", $value: "rebeccapurple" } } },
        },
        { siteName: "Acme", sitePurpose: "SaaS" },
      ),
      "add_module_to_page",
    );
    expect(exotic.blocked).toBe(false);

    const grayOklch = await checkColdStartGate(
      AI,
      toolCtxWith(
        {
          origin: "ai",
          description: "Branded",
          tokens: { color: { primary: { $type: "color", $value: "oklch(20% 0.01 260)" } } },
        },
        { siteName: "Acme", sitePurpose: "SaaS" },
      ),
      "add_module_to_page",
    );
    expect(grayOklch.blocked).toBe(true);
  });
});
