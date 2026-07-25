// SPDX-License-Identifier: MPL-2.0

/**
 * DRY AI-tool factory for the `_many` bulk variants (CLAUDE.md §11 —
 * "the AI plans a multi-row change and posts it in one tool call"). Pairs with
 * `defineBulkOp` on the op side: `makeBulkTool` produces the chat-runner tool
 * whose single argument is `{ items: [...] }` and dispatches the matching
 * `*_many` op in one round-trip.
 *
 * The item schemas are supplied by the caller (the singular tool's Zod schema +
 * its JSON Schema for one item), so the bulk tool advertises the exact same
 * per-item shape the singular tool does — the two can't drift.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler, ToolInputSchema } from "./dispatch.js";

/** Configuration for {@link makeBulkTool}. */
export interface MakeBulkToolConfig<Item> {
  /** The bulk tool name, e.g. `"set_content_instance_values_many"`. */
  readonly name: string;
  /** AI-facing description (when to use, when to prefer over the singular). */
  readonly description: string;
  /** Zod schema for ONE item — the singular tool's schema. */
  readonly itemInputSchema: z.ZodType<Item>;
  /** JSON Schema for ONE item — becomes the `items` array element schema. */
  readonly itemJsonSchema: ToolInputSchema;
  /** The `*_many` op this tool dispatches (built via `defineBulkOp`). */
  readonly opName: string;
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
  const { name, description, itemInputSchema, itemJsonSchema, opName } = config;
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
        return {
          ok: false,
          content: `${opName} failed (whole batch rolled back): ${describeError(r.error)}`,
        };
      }
      return { ok: true, content: `${toolInput.items.length} item(s) updated.` };
    },
  };
}
