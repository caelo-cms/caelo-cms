// SPDX-License-Identifier: MPL-2.0

/**
 * DRY AI-tool factory for the `_many` bulk variants (CLAUDE.md §11 —
 * "the AI plans a multi-row change and posts it in one tool call"). Pairs with
 * `defineBulkOp` on the op side: `makeBulkTool` produces the chat-runner tool
 * whose single argument is `{ items: [...] }` and dispatches the matching
 * `*_many` op in one round-trip.
 *
 * The item schemas are supplied by the caller (the op's per-item Zod schema +
 * its JSON Schema for one item); one item is the n=1 case, so there is no
 * separate singular tool to drift from.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { z } from "zod";
import { describeError, toolError } from "./_describe-error.js";
import type { ToolContext, ToolDefinitionWithHandler, ToolInputSchema } from "./dispatch.js";

/** Configuration for {@link makeBulkTool}. */
export interface MakeBulkToolConfig<Item> {
  /** The bulk tool name, e.g. `"set_content_instance_values_many"`. */
  readonly name: string;
  /** AI-facing description (routing + core rules; see the tool-description rulebook). */
  readonly description: string;
  /** Zod schema for ONE item — the op's per-item input. */
  readonly itemInputSchema: z.ZodType<Item>;
  /** JSON Schema for ONE item — becomes the `items` array element schema. */
  readonly itemJsonSchema: ToolInputSchema;
  /** The `*_many` op this tool dispatches (built via `defineBulkOp`). */
  readonly opName: string;
  /**
   * Optional text appended to a SUCCESSFUL result (leading space included,
   * "" for nothing) — e.g. the stage-readiness note after a write that
   * changes what a Stage would build.
   */
  readonly resultSuffix?: (ctx: ExecutionContext, toolCtx: ToolContext) => Promise<string>;
  /**
   * Optional formatter for a SUCCESSFUL result, given the op's ok-value
   * (`{ results, count }` from `defineBulkOp`) and the tool input — for
   * per-item facts the AI must see (where an edit propagated, which item
   * was already filled). Default: "N item(s) updated."
   */
  readonly formatResult?: (value: unknown, input: { items: Item[] }) => string;
}

/**
 * Build a bulk AI tool that wraps its N items into one `{ items }` call and
 * dispatches `opName`. All-or-nothing on the op side — any invalid item aborts
 * the whole batch (the op's error names the failing index).
 *
 * @returns a {@link ToolDefinitionWithHandler} ready to `registry.register(...)`.
 */
export function makeBulkTool<Item>(
  config: MakeBulkToolConfig<Item>,
): ToolDefinitionWithHandler<{ items: Item[] }> {
  const { name, description, itemInputSchema, itemJsonSchema, opName, resultSuffix, formatResult } =
    config;
  return {
    name,
    description,
    schema: z.object({ items: z.array(itemInputSchema).min(1) }).strict(),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: { type: "array", items: itemJsonSchema },
      },
    },
    handler: async (ctx, toolInput, toolCtx) => {
      const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, opName, {
        items: toolInput.items,
      });
      if (!r.ok) {
        return toolError(r.error, `${opName} failed: ${describeError(r.error)}`);
      }
      const suffix = resultSuffix ? await resultSuffix(ctx, toolCtx) : "";
      const head = formatResult
        ? formatResult(r.value, toolInput)
        : `${toolInput.items.length} item(s) updated.`;
      return { ok: true, content: `${head}${suffix}` };
    },
  };
}
