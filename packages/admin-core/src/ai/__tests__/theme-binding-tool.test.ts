// SPDX-License-Identifier: MPL-2.0

/**
 * issue #164 slice 2 — tool-level binding wiring: with
 * `bindThemeLiterals: true` the op receives the BOUND css (literals →
 * var(--…)) and the result reports every rewrite; without the flag the
 * css passes through untouched; place mode rejects the flag at the
 * boundary (mode exclusivity).
 */

import { describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { addModuleToPageToolInput, type ExecutionContext, ok } from "@caelo-cms/shared";
import { registerAdminOps } from "../../register.js";
import type { ToolContext } from "../tools/dispatch.js";
import { editModuleTool } from "../tools/edit-module.js";

const registry = new OperationRegistry();
registerAdminOps(registry);

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "issue-164-binding-unit",
};

const TOKENS = {
  color: { primary: { $type: "color", $value: "#4f46e5" } },
  gradient: {
    hero: { $type: "gradient", $value: "linear-gradient(135deg, #4f46e5, #7c3aed)" },
  },
};

function toolCtxRecording(opInputs: Record<string, unknown>[]): ToolContext {
  const adapter = {
    // execute() calls runOperation(op, ctx, parsedInput).
    runOperation: async (op: { name: string }, _ctx: unknown, input: unknown) => {
      if (op.name === "themes.get_active") return ok({ theme: { tokens: TOKENS } });
      if (op.name === "modules.update") {
        opInputs.push(input as Record<string, unknown>);
        return ok({});
      }
      return ok({});
    },
  } as unknown as DatabaseAdapter;
  return { adapter, registry } as ToolContext;
}

describe("bindThemeLiterals (issue #164 slice 2)", () => {
  it("edit_module writes the BOUND css and reports rewrites", async () => {
    const opInputs: Record<string, unknown>[] = [];
    const res = await editModuleTool.handler(
      AI,
      {
        moduleId: "11111111-1111-4111-8111-111111111101",
        css: ".hero{background:linear-gradient(135deg, #4f46e5, #7c3aed)}.cta{background:#4f46e5}",
        bindThemeLiterals: true,
      },
      toolCtxRecording(opInputs),
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("bound");
    expect(res.content).toContain("var(--gradient-hero)");
    const written = opInputs[0]?.css as string;
    expect(written).toContain("background:var(--gradient-hero)");
    expect(written).toContain("background:var(--color-primary)");
    expect(opInputs[0]?.bindThemeLiterals).toBeUndefined(); // flag never reaches the op
  });

  it("without the flag, css passes through untouched", async () => {
    const opInputs: Record<string, unknown>[] = [];
    await editModuleTool.handler(
      AI,
      { moduleId: "11111111-1111-4111-8111-111111111101", css: ".cta{background:#4f46e5}" },
      toolCtxRecording(opInputs),
    );
    expect(opInputs[0]?.css).toBe(".cta{background:#4f46e5}");
  });

  it("place mode rejects the flag at the boundary (mode exclusivity)", () => {
    const r = addModuleToPageToolInput.safeParse({
      pageId: "11111111-1111-4111-8111-111111111101",
      blockName: "content",
      position: "bottom",
      moduleId: "11111111-1111-4111-8111-111111111102",
      bindThemeLiterals: true,
    });
    expect(r.success).toBe(false);
  });
});
