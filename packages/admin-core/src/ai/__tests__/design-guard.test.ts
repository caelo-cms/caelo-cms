// SPDX-License-Identifier: MPL-2.0

/**
 * issue #166 — static consistency gate: the three finding classes
 * (literal-duplicates-token, pattern-reuse, roles-in-play), silence
 * without a manifest, and silence on conformant writes (no noise).
 */

import { describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import type { DesignManifest, ExecutionContext } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
import { registerAdminOps } from "../../register.js";
import { designGuardSuffix } from "../tools/_design-guard.js";
import type { ToolContext } from "../tools/dispatch.js";

const registry = new OperationRegistry();
registerAdminOps(registry);

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "issue-166-unit",
};

const TOKENS = { color: { primary: { $type: "color", $value: "#4f46e5" } } };

const MANIFEST: DesignManifest = {
  tokenRoles: { "--color-primary": "CTAs and links only" },
  patterns: [{ name: "hero", moduleType: "hero-banner", spec: "gradient hero, one CTA" }],
};

function toolCtxWith(manifest: DesignManifest | null): ToolContext {
  const adapter = {
    runOperation: async (op: { name: string }) => {
      if (op.name === "design_manifest.get") return ok({ manifest });
      if (op.name === "themes.get_active") return ok({ theme: { tokens: TOKENS } });
      return ok({});
    },
  } as unknown as DatabaseAdapter;
  return { adapter, registry } as ToolContext;
}

describe("designGuardSuffix (issue #166)", () => {
  it("flags literals that duplicate token values", async () => {
    const s = await designGuardSuffix(AI, toolCtxWith(MANIFEST), {
      css: ".cta{background:#4f46e5}",
    });
    expect(s).toContain("design-guard");
    expect(s).toContain("#4f46e5 (=var(--color-primary))");
    expect(s).toContain("bindThemeLiterals");
  });

  it("surfaces token roles for the vars the css references", async () => {
    const s = await designGuardSuffix(AI, toolCtxWith(MANIFEST), {
      css: ".x{color:var(--color-primary)}",
    });
    expect(s).toContain("--color-primary = CTAs and links only");
  });

  it("points lookalike mints at the established pattern's module type", async () => {
    const s = await designGuardSuffix(AI, toolCtxWith(MANIFEST), {
      css: ".h{color:var(--color-foreground)}",
      displayName: "Hero Splash",
      kind: "hero",
      type: "hero-splash",
    });
    expect(s).toContain('"hero" pattern');
    expect(s).toContain("`hero-banner`");
  });

  it("stays silent without a manifest and on conformant writes", async () => {
    expect(
      await designGuardSuffix(AI, toolCtxWith(null), { css: ".cta{background:#4f46e5}" }),
    ).toBe("");
    expect(
      await designGuardSuffix(AI, toolCtxWith(MANIFEST), {
        css: ".p{padding:2rem}",
        displayName: "FAQ list",
        kind: "content",
        type: "faq-list",
      }),
    ).toBe("");
  });

  it("does not re-flag a mint that USES the pattern's module type", async () => {
    const s = await designGuardSuffix(AI, toolCtxWith(MANIFEST), {
      css: ".h{padding:2rem}",
      displayName: "Hero for landing",
      kind: "hero",
      type: "hero-banner",
    });
    expect(s).toBe("");
  });
});
