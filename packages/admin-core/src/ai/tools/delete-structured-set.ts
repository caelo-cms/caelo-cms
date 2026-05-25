// SPDX-License-Identifier: MPL-2.0

/**
 * v0.10.22 — AI tool: delete_structured_set. Removes a structured-data
 * set by `kind` + `slug`. Looks up the set id via `structured_sets.get`
 * and forwards to `structured_sets.delete` (the op takes `setId` rather
 * than `kind+slug`; this wrapper hides that — the AI never sees raw
 * set ids and shouldn't need to).
 *
 * Recovery: `set_structured_set` with the same `kind+slug` re-creates
 * the set. Item references in module HTML (slug `<kind>-<slug>`) will
 * fall back to empty render after delete; clean up the rendering
 * module separately if the deletion is intentional.
 *
 * Part of the unified structured-sets CRUD surface: list / get / set /
 * delete.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const deleteStructuredSetToolInput = z
  .object({
    kind: z.enum(["nav-menu", "taxonomy", "tags", "link-list", "language-selector"]),
    slug: z.string().min(1).max(120),
  })
  .strict();

type DeleteStructuredSetToolInput = z.infer<typeof deleteStructuredSetToolInput>;

export const deleteStructuredSetTool: ToolDefinitionWithHandler<DeleteStructuredSetToolInput> = {
  name: "delete_structured_set",
  description:
    "Delete a structured-data set by `kind` + `slug`. " +
    "Reversible by calling `set_structured_set` with the same kind+slug. " +
    "If a module with slug `<kind>-<slug>` references this set, that module's render falls back to empty after delete — remove or rewrite the module separately if needed. " +
    "Returns an error if no set exists for that kind+slug.",
  schema: deleteStructuredSetToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "slug"],
    properties: {
      kind: {
        enum: ["nav-menu", "tags", "taxonomy", "link-list", "language-selector"],
      },
      slug: { type: "string", minLength: 1, maxLength: 120 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // Look up id first — the underlying op takes setId for safety
    // (cascade-friendly + matches the audit-log convention of one
    // entity-id per row).
    const getR = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "structured_sets.get",
      input,
    );
    if (!getR.ok) {
      return { ok: false, content: `structured_sets.get failed: ${describeError(getR.error)}` };
    }
    const set = (getR.value as { set: { id: string } | null }).set;
    if (!set) {
      return {
        ok: false,
        content: `No set found for ${input.kind}/${input.slug} — nothing to delete.`,
      };
    }
    const delR = await execute(toolCtx.registry, toolCtx.adapter, ctx, "structured_sets.delete", {
      setId: set.id,
    });
    if (!delR.ok) {
      return { ok: false, content: `structured_sets.delete failed: ${describeError(delR.error)}` };
    }
    return { ok: true, content: `${input.kind}/${input.slug} deleted.` };
  },
};
