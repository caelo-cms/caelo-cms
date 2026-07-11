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
import type { ToolContext } from "../tools/dispatch.js";
import { editModuleTool } from "../tools/edit-module.js";
import { updateThemeTokensTool } from "../tools/update-theme-tokens.js";

const registry = new OperationRegistry();
registerAdminOps(registry);

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

function toolCtxWith(overrides: { moduleCss?: string } = {}): ToolContext {
  const adapter = {
    runOperation: async (op: { name: string }) => {
      switch (op.name) {
        case "themes.get_active":
          return ok({ theme: { tokens: TOKENS } });
        case "modules.update":
          return ok({});
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
          return ok({ layouts: [] });
        default:
          return ok({});
      }
    },
  } as unknown as DatabaseAdapter;
  return { adapter, registry } as ToolContext;
}

describe("authoring-tool css-var warning (issue #156)", () => {
  it("edit_module flags a typo'd var with a did-you-mean", async () => {
    const res = await editModuleTool.handler(
      AI,
      {
        moduleId: "11111111-1111-4111-8111-111111111101",
        css: ".hero{color:var(--color-foregruond)}",
      },
      toolCtxWith(),
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("Unknown CSS vars");
    expect(res.content).toContain("--color-foregruond");
    expect(res.content).toContain("did you mean `--color-foreground`?");
  });

  it("edit_module stays quiet on clean css and locally-defined props", async () => {
    const res = await editModuleTool.handler(
      AI,
      {
        moduleId: "11111111-1111-4111-8111-111111111101",
        css: ".hero{--hero-angle:3deg;color:var(--color-primary);rotate:var(--hero-angle)}",
      },
      toolCtxWith(),
    );
    expect(res.ok).toBe(true);
    expect(res.content).not.toContain("Unknown CSS vars");
  });

  it("edit_module without css never fetches the theme (no scan, no noise)", async () => {
    const res = await editModuleTool.handler(
      AI,
      { moduleId: "11111111-1111-4111-8111-111111111101", html: "<p>{{body_text}}</p>" },
      toolCtxWith(),
    );
    expect(res.ok).toBe(true);
    expect(res.content).toBe("module 11111111-1111-4111-8111-111111111101 updated");
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
