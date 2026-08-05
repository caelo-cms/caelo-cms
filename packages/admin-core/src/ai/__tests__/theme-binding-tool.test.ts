// SPDX-License-Identifier: MPL-2.0

/**
 * issue #164 slice 2 — tool-level binding wiring: the op receives the
 * BOUND css (literals → var(--…)) and the result reports every rewrite;
 * place mode tolerates the flag at the boundary (mode exclusivity).
 *
 * issue #430 — binding is now the DEFAULT. Opting in was a correction
 * round-trip we asked the AI to make for something we can do ourselves,
 * and nobody opted in: six modules on the dogfood install hardcoded
 * exact token values. Only an explicit `false` passes css through.
 */

import { describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { addModuleToolInput, type ExecutionContext, ok } from "@caelo-cms/shared";
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

  it("binds by DEFAULT when the flag is omitted (issue #430)", async () => {
    const opInputs: Record<string, unknown>[] = [];
    await editModuleTool.handler(
      AI,
      { moduleId: "11111111-1111-4111-8111-111111111101", css: ".cta{background:#4f46e5}" },
      toolCtxRecording(opInputs),
    );
    expect(opInputs[0]?.css).toBe(".cta{background:var(--color-primary)}");
  });

  it("passes css through untouched ONLY on an explicit false", async () => {
    const opInputs: Record<string, unknown>[] = [];
    await editModuleTool.handler(
      AI,
      {
        moduleId: "11111111-1111-4111-8111-111111111101",
        css: ".cta{background:#4f46e5}",
        bindThemeLiterals: false,
      },
      toolCtxRecording(opInputs),
    );
    expect(opInputs[0]?.css).toBe(".cta{background:#4f46e5}");
  });

  it("place mode TOLERATES the flag at the boundary (placement-only, handler surfaces the ignored-authoring info)", () => {
    // §1A/§11 — a valid placement must never fail over an extra authoring
    // field. moduleId + bindThemeLiterals passes the schema; bindThemeLiterals
    // is an authoring concern that placement does not apply, so the tool
    // handler (not the schema) reports it as ignored.
    const r = addModuleToolInput.safeParse({
      target: "page",
      targetRef: "11111111-1111-4111-8111-111111111101",
      blockName: "content",
      position: "bottom",
      moduleId: "11111111-1111-4111-8111-111111111102",
      bindThemeLiterals: true,
    });
    expect(r.success).toBe(true);
  });
});
