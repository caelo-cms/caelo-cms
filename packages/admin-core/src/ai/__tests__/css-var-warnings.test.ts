// SPDX-License-Identifier: MPL-2.0

/**
 * issue #156 — tool-level wiring of the CSS var guard: authoring tools
 * append a did-you-mean warning when written CSS references vars the
 * active theme doesn't emit; `set_theme_tokens` names entities left
 * dangling after a token removal. Fake-adapter pattern as in
 * cold-start-gate.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
import { registerAdminOps } from "../../register.js";
import { updateModulesManyTool } from "../tools/bulk-pages-modules.js";
import type { ToolContext } from "../tools/dispatch.js";
import { updateThemeTokensTool } from "../tools/update-theme-tokens.js";

const registry = new OperationRegistry();
registerAdminOps(registry);

const MODULE_ID = "11111111-1111-4111-8111-111111111101";

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "issue-156-unit",
};

const TOKENS = {
  color: {
    primary: { $type: "color", $value: "#4f46e5" },
    foreground: { $type: "color", $value: "#0f172a" },
    background: { $type: "color", $value: "#ffffff" },
  },
};

function toolCtxWith(overrides: { moduleCss?: string; layoutCss?: string } = {}): ToolContext {
  const adapter = {
    runOperation: async (op: { name: string }, _ctx: unknown, input: unknown) => {
      switch (op.name) {
        case "themes.get_active":
          return ok({ theme: { tokens: TOKENS } });
        case "modules.update_many": {
          const n = (input as { updates: unknown[] }).updates.length;
          return ok({ updated: n, notFoundIds: [], failed: [], extracted: [] });
        }
        // #158 — a css-only module edit reads the stored root for the scope check.
        case "modules.get":
          return ok({ module: { html: '<section class="hero"></section>' } });
        case "themes.update_tokens":
          return ok({
            themeId: "t1",
            canonicalPathsWritten: [],
            canonicalPathsRemoved: ["color.accent"],
          });
        case "modules.list":
          return ok({
            modules: [
              { slug: "hero-banner", css: overrides.moduleCss ?? "" },
              { slug: "clean-footer", css: ".f{color:var(--color-foreground)}" },
            ],
          });
        case "templates.list":
          return ok({ templates: [] });
        case "layouts.list":
          return ok({
            layouts: overrides.layoutCss === undefined ? [] : [{ css: overrides.layoutCss }],
          });
        default:
          return ok({});
      }
    },
  } as unknown as DatabaseAdapter;
  return { adapter, registry } as ToolContext;
}

describe("authoring-tool css-var warning (issue #156)", () => {
  it("a var a layout defines is known, not flagged (#1098)", async () => {
    const res = await updateModulesManyTool.handler(
      AI,
      { items: [{ moduleId: MODULE_ID, css: ".hero{border:1px solid var(--line-hair)}" }] },
      toolCtxWith({ layoutCss: ":root{--line-hair:#e3e7ee}" }),
    );
    expect(res.ok).toBe(true);
    expect(res.content).not.toContain("Unknown CSS vars");

    const flagged = await updateModulesManyTool.handler(
      AI,
      { items: [{ moduleId: MODULE_ID, css: ".hero{border:1px solid var(--line-hair)}" }] },
      toolCtxWith(),
    );
    expect(flagged.content).toContain("Unknown CSS vars");
    expect(flagged.content).toContain("nothing defines it");
    expect(flagged.content).not.toContain("declaration is invalid");
  });

  it("update_modules_many flags a typo'd var with a did-you-mean", async () => {
    const res = await updateModulesManyTool.handler(
      AI,
      { items: [{ moduleId: MODULE_ID, css: ".hero{color:var(--color-foregruond)}" }] },
      toolCtxWith(),
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("Unknown CSS vars");
    expect(res.content).toContain("--color-foregruond");
    expect(res.content).toContain("did you mean `--color-foreground`?");
  });

  it("update_modules_many stays quiet on clean css and locally-defined props", async () => {
    const res = await updateModulesManyTool.handler(
      AI,
      {
        items: [
          {
            moduleId: MODULE_ID,
            css: ".hero{--hero-angle:3deg;color:var(--color-primary);rotate:var(--hero-angle)}",
          },
        ],
      },
      toolCtxWith(),
    );
    expect(res.ok).toBe(true);
    expect(res.content).not.toContain("Unknown CSS vars");
  });

  it("update_modules_many without css never fetches the theme (no scan, no noise)", async () => {
    const res = await updateModulesManyTool.handler(
      AI,
      { items: [{ moduleId: MODULE_ID, html: "<p>{{body_text}}</p>" }] },
      toolCtxWith(),
    );
    expect(res.ok).toBe(true);
    expect(res.content).toBe(
      `Updated 1 of 1 module(s) (notFound=0, failed=0).\n- ${MODULE_ID}: updated`,
    );
  });

  it("names the var warning on the item that wrote it, not on its clean neighbour", async () => {
    const OTHER = "11111111-1111-4111-8111-111111111102";
    const res = await updateModulesManyTool.handler(
      AI,
      {
        items: [
          { moduleId: MODULE_ID, css: ".hero{color:var(--color-primary)}" },
          { moduleId: OTHER, css: ".hero{color:var(--color-foregruond)}" },
        ],
      },
      toolCtxWith(),
    );
    expect(res.ok).toBe(true);
    const lines = res.content.split("\n");
    expect(lines.find((l) => l.startsWith(`- ${MODULE_ID}`))).not.toContain("Unknown CSS vars");
    expect(lines.find((l) => l.startsWith(`- ${OTHER}`))).toContain("--color-foregruond");
  });
});

describe("set_theme_tokens dangling-reference report (issue #156)", () => {
  it("names entities whose css references vars the theme no longer emits", async () => {
    const res = await updateThemeTokensTool.handler(
      AI,
      { remove: ["color.accent"] },
      toolCtxWith({ moduleCss: ".hero{background:var(--color-accent)}" }),
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("removed color.accent");
    expect(res.content).toContain("module:hero-banner");
    expect(res.content).toContain("--color-accent");
    expect(res.content).not.toContain("clean-footer");
  });

  it("stays quiet when nothing dangles", async () => {
    const res = await updateThemeTokensTool.handler(
      AI,
      { remove: ["color.accent"] },
      toolCtxWith({ moduleCss: ".hero{color:var(--color-primary)}" }),
    );
    expect(res.ok).toBe(true);
    expect(res.content).not.toContain("⚠️");
  });
});
