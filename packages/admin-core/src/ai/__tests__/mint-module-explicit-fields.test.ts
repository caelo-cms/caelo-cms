// SPDX-License-Identifier: MPL-2.0

/**
 * Regression: when the AI authors a module with explicit `fields[]`,
 * `mintModuleFromHtml` must NOT run moduleize — that second AI pass
 * renamed `{{label}}`'s field to `button_label` and dropped the `>`
 * from the nested `{{>cta}}` marker, costing ~20 recovery loops in a
 * live nested-CTA turn. The provider stub throws if moduleize touches
 * it, proving the explicit-fields path bypasses moduleize and stores
 * the AI's html + fields verbatim (CLAUDE.md §1A).
 */

import { describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import type { AIProvider, ExecutionContext, ModuleField } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
import { registerAdminOps } from "../../register.js";
import { mintModuleFromHtml } from "../tools/_mint-module.js";
import type { ToolContext } from "../tools/dispatch.js";

const registry = new OperationRegistry();
registerAdminOps(registry);

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "mint-explicit-fields",
};

/** A provider whose use = a test failure (moduleize must never run here). */
const throwingProvider: AIProvider = {
  name: "anthropic",
  model: "test",
  // biome-ignore lint/correctness/useYield: intentionally throws before yielding
  async *generate() {
    throw new Error("moduleize ran despite explicit fields — regression");
  },
};

/**
 * Records the VALIDATED `modules.create` input (execute passes it as the
 * 3rd arg to runOperation) so we can assert html/fields survive verbatim.
 */
function toolCtxRecording(sink: { createInput?: Record<string, unknown> }): ToolContext {
  const adapter = {
    runOperation: async (
      op: { name: string },
      _ctx: unknown,
      validatedInput: Record<string, unknown>,
    ) => {
      if (op.name === "modules.create") {
        sink.createInput = validatedInput;
        return ok({ moduleId: "22222222-2222-4222-8222-222222222222", extractedFields: [] });
      }
      return ok({});
    },
  } as unknown as DatabaseAdapter;
  return { adapter, registry, provider: throwingProvider } as unknown as ToolContext;
}

describe("mintModuleFromHtml — explicit fields bypass moduleize", () => {
  it("stores the exact html + field names verbatim (no rename, no mangle)", async () => {
    const sink: { createInput?: Record<string, unknown> } = {};
    // The live-edit Button: `label` got renamed to `button_label` by the
    // moduleize pass. With explicit fields, moduleize is skipped and the
    // name + placeholder survive.
    const html = "<button>{{label}}</button>";
    const fields: ModuleField[] = [{ name: "label", kind: "text", label: "Label" }];
    const res = await mintModuleFromHtml(AI, toolCtxRecording(sink), {
      html,
      fieldsHint: fields,
      displayNameHint: "CTA button",
      kind: "cta",
      description: "A call-to-action button.",
    });
    expect(res.ok).toBe(true);
    // The `{{label}}` placeholder survived storage unchanged.
    expect(sink.createInput?.html).toBe(html);
    // The AI's field name is untouched — no `button_label`-style rename.
    expect(sink.createInput?.fields).toEqual(fields);
  });
});
