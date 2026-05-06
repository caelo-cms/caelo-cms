// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.6 / v0.2.20 — `create_layout`. AI-callable via the propose/
 * execute gate (CLAUDE.md §11.A): this tool calls
 * `layouts.propose_create` which queues a row at status='pending';
 * the Owner clicks Approve at /security/layouts/pending to actually
 * create the layout. AI does NOT claim the layout exists — it tells
 * the operator to approve.
 */

import { execute } from "@caelo-cms/query-api";
import { createLayoutToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const createLayoutTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").CreateLayoutToolInput
> = {
  name: "create_layout",
  description:
    "Propose a new layout (site shell). TWO-STEP: this only QUEUES the proposal at /security/layouts/pending; " +
    "an Owner must click Approve to actually create the layout. DO NOT claim the layout exists. " +
    'Use when the user wants a chrome variant that none of the existing layouts cover (e.g. "a campaign layout ' +
    'with a banner and no footer"). After Approve, you can bind templates to it via `set_template_layout` or ' +
    "fill its blocks via `add_module_to_layout`.",
  schema: createLayoutToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["slug", "displayName", "html", "blocks"],
    properties: {
      slug: { type: "string", minLength: 1, maxLength: 120 },
      displayName: { type: "string", minLength: 1, maxLength: 200 },
      html: { type: "string", minLength: 1, maxLength: 50_000 },
      css: { type: "string", maxLength: 50_000 },
      blocks: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "displayName", "position"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
            displayName: { type: "string", minLength: 1, maxLength: 200 },
            position: { type: "integer", minimum: 0, maximum: 1000 },
          },
        },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const res = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.propose_create", {
      slug: input.slug,
      displayName: input.displayName,
      html: input.html,
      css: input.css ?? "",
      blocks: input.blocks,
    });
    if (!res.ok) {
      return { ok: false, content: `layouts.propose_create failed: ${describeError(res.error)}` };
    }
    const v = res.value as { proposalId: string; preview: { blockCount: number } };
    return {
      ok: true,
      content:
        `Queued layout-create proposal ${v.proposalId} (slug=${input.slug}, ${v.preview.blockCount} blocks). ` +
        `An Owner must click Approve at /security/layouts/pending to create the layout.`,
    };
  },
};
