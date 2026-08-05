// SPDX-License-Identifier: MPL-2.0

/**
 * issue #166 — static consistency gate: the three finding classes
 * (literal-duplicates-token, pattern-reuse, roles-in-play) and silence
 * on conformant writes (no noise).
 *
 * issue #430 — the regression this file now pins: the guard must work
 * with NOTHING captured up front. Its inputs are the active theme (roles
 * ride on each token's `$description`) and the module rows, both of which
 * every install already has. The old version required a Design Manifest
 * row and returned "" without one, which is why it stayed silent through
 * all 18 module writes on the dogfood install.
 */

import { describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
import { registerAdminOps } from "../../register.js";
import { designGuardSuffix } from "../tools/_design-guard.js";
import type { ToolContext } from "../tools/dispatch.js";

const registry = new OperationRegistry();
registerAdminOps(registry);

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "issue-430-unit",
};

/** Theme carrying a value AND the role recorded alongside it. */
const TOKENS = {
  color: {
    primary: {
      $type: "color",
      $value: "#4f46e5",
      $description: "CTAs and links only — never large background fills",
    },
    foreground: { $type: "color", $value: "#0a0a0a" },
  },
};

const MODULES = [
  {
    displayName: "Hero Banner",
    kind: "hero",
    type: "hero-banner",
    description: "Gradient hero with one CTA",
  },
  { displayName: "FAQ Accordion", kind: "content", type: "faq-accordion", description: "" },
];

function toolCtx(opts: { tokens?: unknown; modules?: unknown[] } = {}): ToolContext {
  const adapter = {
    runOperation: async (op: { name: string }) => {
      if (op.name === "themes.get_active") {
        const tokens = opts.tokens === undefined ? TOKENS : opts.tokens;
        return ok({ theme: tokens === null ? null : { tokens } });
      }
      if (op.name === "modules.list") return ok({ modules: opts.modules ?? MODULES });
      return ok({});
    },
  } as unknown as DatabaseAdapter;
  return { adapter, registry } as ToolContext;
}

describe("designGuardSuffix (issues #166, #430)", () => {
  it("flags literals that duplicate token values with no manifest captured", async () => {
    const s = await designGuardSuffix(AI, toolCtx(), { css: ".cta{background:#4f46e5}" });
    expect(s).toContain("design-guard");
    expect(s).toContain("#4f46e5 (=var(--color-primary))");
  });

  it("replays the role recorded on the token for vars the css references", async () => {
    const s = await designGuardSuffix(AI, toolCtx(), { css: ".x{color:var(--color-primary)}" });
    expect(s).toContain("--color-primary = CTAs and links only — never large background fills");
  });

  it("points lookalike mints at the existing module's type", async () => {
    const s = await designGuardSuffix(AI, toolCtx(), {
      css: ".h{color:var(--color-foreground)}",
      displayName: "Hero Splash",
      kind: "hero",
      type: "hero-splash",
    });
    expect(s).toContain('"Hero Banner"');
    expect(s).toContain("`hero-banner`");
  });

  it("stays silent on conformant writes", async () => {
    expect(
      await designGuardSuffix(AI, toolCtx(), {
        css: ".p{padding:2rem}",
        displayName: "Pricing table",
        kind: "content",
        type: "pricing-table",
      }),
    ).toBe("");
  });

  it("does not flag a mint that REUSES the existing module's type", async () => {
    const s = await designGuardSuffix(AI, toolCtx(), {
      css: ".h{padding:2rem}",
      displayName: "Hero for landing",
      kind: "hero",
      type: "hero-banner",
    });
    expect(s).toBe("");
  });

  it("does not cross-flag a same-name module of a different kind", async () => {
    const s = await designGuardSuffix(AI, toolCtx(), {
      css: ".b{padding:2rem}",
      displayName: "Hero Banner copy",
      kind: "content",
      type: "banner-strip",
    });
    expect(s).toBe("");
  });

  it("reports nothing when the install has no active theme", async () => {
    expect(
      await designGuardSuffix(AI, toolCtx({ tokens: null }), { css: ".cta{background:#4f46e5}" }),
    ).toBe("");
  });

  it("omits roles-in-play for tokens that carry no recorded role", async () => {
    const s = await designGuardSuffix(AI, toolCtx(), { css: ".x{color:var(--color-foreground)}" });
    expect(s).toBe("");
  });
});
