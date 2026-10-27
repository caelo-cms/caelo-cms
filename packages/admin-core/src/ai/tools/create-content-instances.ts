// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: create_content_instances — mints 1..N shared content_instances in
 * ONE transaction (the former singular create_content_instance is its n=1
 * case; retired-tools.ts maps old calls here). Dispatches
 * `content_instances.create_many`, which runs the singular op path per item;
 * any invalid item rolls the whole batch back.
 */

import { execute } from "@caelo-cms/query-api";
import { createContentInstanceToolInput } from "@caelo-cms/shared";
import { z } from "zod";
import { describeError, forwardRefusal } from "./_describe-error.js";
import { INTERNAL_LINK_CONTRACT } from "./_internal-link-contract.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const createContentInstancesInput = z
  .object({ items: z.array(createContentInstanceToolInput).min(1).max(100) })
  .strict();
type CreateContentInstancesInput = z.infer<typeof createContentInstancesInput>;

export const createContentInstancesTool: ToolDefinitionWithHandler<CreateContentInstancesInput> = {
  name: "create_content_instances",
  description: [
    "Mint 1..N shared, reusable content_instances in one transaction — for content shown identically on several pages (site footer copyright, brand banner on product pages, repeated blog CTA). Bind each via `set_placement_content({syncMode:'synced'})`; edits then propagate everywhere bound.",
    "DO NOT USE FOR: one-off per-page content -> `set_page_module_content_many` (auto-mints a private instance); creating the page/modules too -> `build_page` (its `content` mints + binds in the same call).",
    "CORE RULES:",
    "- BEFORE CALLING: check `list_content_instances` — a row with matching purpose + module + placement pattern -> BIND it via `set_placement_content`; duplicate shared rows defeat the point.",
    "- All-or-nothing: an invalid item aborts the batch (error names `items[i]` + failing field); nothing is written.",
    INTERNAL_LINK_CONTRACT,
  ].join("\n"),
  schema: createContentInstancesInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["moduleId"],
          properties: {
            moduleId: { type: "string", format: "uuid" },
            slug: {
              type: "string",
              pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
              description: "Handle, unique per module.",
            },
            displayName: { type: "string", minLength: 1, maxLength: 128 },
            purpose: {
              type: "string",
              maxLength: 1000,
              description:
                'Why this row is shared, one line (e.g. "Pricing CTA at the bottom of every pricing-adjacent page"); `list_content_instances` shows it for reuse-vs-fork decisions. Always set it.',
            },
            values: {
              type: "object",
              additionalProperties: true,
              description: "Keyed by the module's field names.",
            },
          },
        },
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "content_instances.create_many",
      { instances: input.items },
    );
    if (!r.ok) {
      return {
        ok: false,
        // The op names its own `instances[i]`; the AI sent `items[i]`.
        content: `content_instances.create_many failed (whole batch rolled back): ${describeError(r.error).replaceAll("instances[", "items[")}`,
        ...forwardRefusal(r.error),
      };
    }
    const { contentInstanceIds } = r.value as { contentInstanceIds: string[] };
    return {
      ok: true,
      content:
        `${contentInstanceIds.length} content_instance(s) created in one transaction:\n` +
        contentInstanceIds
          .map((id, i) => {
            const slug = input.items[i]?.slug;
            return `items[${i}] -> ${id}${slug ? ` (slug=${slug})` : ""}`;
          })
          .join("\n") +
        "\nBind them to placements via set_placement_content (or build_page content.source='existing').",
      value: { contentInstanceIds },
    };
  },
};
