// SPDX-License-Identifier: MPL-2.0

/**
 * Factory for read-only "state endpoint" tools — the on-demand
 * counterparts to the system-prompt context chunks. The chunks are a
 * snapshot from turn start; these tools fetch the CURRENT state so the
 * AI never has to guess whether its own write landed (and never repeats
 * a confirmed write because a stale chunk still shows the old value).
 *
 * DRY rationale (2026-07 audit): 95 tools carried a hand-written JSON
 * `inputSchema` DUPLICATING their Zod `schema`, and 80 repeated the
 * same execute → describeError → format handler body. This factory is
 * the read-side sibling of `makeProposeTool`: define the Zod schema
 * once (JSON Schema is generated via `z.toJSONSchema`), pass the op
 * name and a formatter, done. List tools (TOON rows, paging) are built
 * by `makeListReadTool` in `_list-read-tool.ts`.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { z } from "zod";
import { describeError, toolError } from "./_describe-error.js";
import type { ToolContext, ToolDefinitionWithHandler } from "./dispatch.js";
import { generateInputSchema } from "./generate-input-schema.js";

export interface MakeReadToolArgs<I> {
  readonly name: string;
  readonly description: string;
  /** Query-API op to execute (must be a read with AI actor scope). */
  readonly opName: string;
  /** Zod input schema — the JSON Schema is GENERATED from it. */
  readonly input: z.ZodType<I>;
  /**
   * Map the tool input to the op input. Default: pass through verbatim.
   * Use when the op needs context the model shouldn't supply (e.g. the
   * chat session id from ToolContext).
   */
  readonly buildOpInput?: (input: I, ctx: ExecutionContext, toolCtx: ToolContext) => unknown;
  /** Render the op's ok-value into the tool's text content. */
  readonly format: (value: unknown, input: I) => string;
  /**
   * Pass the raw op value through as the tool result's `value` (the
   * chat-runner's structured retry path reads it). Default true; set
   * false when the op payload carries data that must NOT enter the
   * transcript (e.g. ai_providers.list's config can include API keys).
   */
  readonly includeValue?: boolean;
  /**
   * Execute the op as the human operator (`toolCtx.humanCtx`) when there is
   * one, instead of the AI actor. For actor-sensitive reads — e.g. per-actor
   * budget spend, which is recorded against the operator — where the AI
   * actor's own view would be empty. Reads only; never set on a write.
   */
  readonly runAsOperator?: boolean;
}

/** Build a read tool: Zod schema in, JSON Schema + standard handler out. */
export function makeReadTool<I>(args: MakeReadToolArgs<I>): ToolDefinitionWithHandler<I> {
  return {
    name: args.name,
    description: args.description,
    schema: args.input,
    // Single source of truth: the wire JSON Schema is generated from the
    // Zod schema — no hand-maintained duplicate to drift. `io: "input"`
    // (inside generateInputSchema) keeps defaulted fields optional.
    inputSchema: generateInputSchema(args.input),
    handler: async (ctx, input, toolCtx) => {
      const opInput = args.buildOpInput ? args.buildOpInput(input, ctx, toolCtx) : input;
      const execCtx = args.runAsOperator && toolCtx.humanCtx ? toolCtx.humanCtx : ctx;
      const r = await execute(toolCtx.registry, toolCtx.adapter, execCtx, args.opName, opInput);
      if (!r.ok) {
        return toolError(r.error, `${args.opName} failed: ${describeError(r.error)}`);
      }
      return {
        ok: true,
        content: args.format(r.value, input),
        ...(args.includeValue === false ? {} : { value: r.value }),
      };
    },
  };
}
