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
 *
 * issue #820 — pattern-reuse compares the markup, not the display name:
 * the name match never fired on the real copies (a diff card pasted as a
 * new module under a different name).
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

const DIFF_CARD =
  '<div class="diff-card"><div class="diff-head"><span class="dot"></span></div><pre class="diff-body">{{code}}</pre></div>';
const MODULES = [
  { id: "00000000-0000-4000-8000-000000000001", displayName: "Diff card", html: DIFF_CARD },
  {
    id: "00000000-0000-4000-8000-000000000002",
    displayName: "FAQ Accordion",
    html: '<section class="faq"><details class="q"><summary>{{q}}</summary><div class="a"><p>{{a}}</p></div></details></section>',
  },
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

  it("points a structural copy of an existing module at that module", async () => {
    const s = await designGuardSuffix(AI, toolCtx(), {
      html: DIFF_CARD.replace("{{code}}", "{{diff}}"),
      excludeModuleIds: ["00000000-0000-4000-8000-0000000000ff"],
    });
    expect(s).toContain('structurally identical to the existing module "Diff card"');
  });

  it("names another module's markup nested inside a new one", async () => {
    const s = await designGuardSuffix(AI, toolCtx(), {
      html: `<div class="split"><div class="copy"><h2>{{t}}</h2></div>${DIFF_CARD}</div>`,
    });
    expect(s).toContain('contains the markup of module "Diff card"');
    expect(s).toContain("{{>field}}");
  });

  it("stays silent on conformant writes", async () => {
    expect(
      await designGuardSuffix(AI, toolCtx(), {
        css: ".pricing{padding:2rem}",
        html: '<table class="pricing"><tr><th>{{a}}</th><td>{{b}}</td></tr></table>',
      }),
    ).toBe("");
  });

  it("never matches the module the write itself created or edited", async () => {
    const s = await designGuardSuffix(AI, toolCtx(), {
      html: DIFF_CARD,
      excludeModuleIds: ["00000000-0000-4000-8000-000000000001"],
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
  it("flags module CSS that is not scoped to the module root (issue #158)", async () => {
    const s = await designGuardSuffix(AI, toolCtx(), {
      css: ".pricing h2{margin:0} h3{margin:0} .card{padding:1rem}",
      html: '<section class="pricing"><h2>{{t}}</h2></section>',
    });
    expect(s).toContain("`h3` style EVERY matching element on the page");
    expect(s).toContain("`.card` are not scoped to this module");
    expect(s).toContain("`.pricing h2`");
  });

  it("checks a css-only restyle against the module's stored root (issue #158)", async () => {
    const ctx = toolCtx();
    const base = ctx.adapter.runOperation.bind(ctx.adapter);
    ctx.adapter.runOperation = (async (op: { name: string }, ...rest: unknown[]) =>
      op.name === "modules.get"
        ? ok({ module: { html: '<section class="hero"></section>' } })
        : (base as (...a: unknown[]) => unknown)(op, ...rest)) as typeof ctx.adapter.runOperation;
    const s = await designGuardSuffix(AI, ctx, {
      css: ".hero-title{} .card{}",
      scopeModuleId: "00000000-0000-4000-8000-0000000000aa",
    });
    expect(s).toContain("`.card` are not scoped");
    expect(s).not.toContain("`.hero-title`");
  });

  it("names a data-caelo-ui value outside the vetted kit (issue #160)", async () => {
    const s = await designGuardSuffix(AI, toolCtx(), {
      html: '<div class="gallery" data-caelo-ui="lightbox"></div>',
    });
    expect(s).toContain('"lightbox" are not in the vetted interaction kit');
    expect(s).toContain('"accordion"');
  });
});
