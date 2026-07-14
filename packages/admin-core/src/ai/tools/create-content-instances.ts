// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #299 — AI tool: create_content_instances (bulk). Mints N
 * content_instances in ONE transaction. Run #15 fired the singular
 * create_content_instance 7+ times in a row for what was conceptually
 * one operation; per CLAUDE.md §11 the bulk variant is the default.
 */

import { execute } from "@caelo-cms/query-api";
import { contentInstancesCreateManySchema } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const createContentInstancesTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").ContentInstancesCreateManyInput
> = {
  name: "create_content_instances",
  description:
    "Mint SEVERAL content_instances in ONE transaction — prefer this over multiple `create_content_instance` calls whenever you need more than one instance (§11 bulk-first: one round-trip instead of N). All-or-nothing: any invalid item aborts the whole batch (the error names `instances[i]` and, for value problems, the failing field) and nothing is written. " +
    "Each item is the exact `create_content_instance` shape: `{moduleId, values, purpose?, slug?, displayName?}` — `purpose` required for SHARED rows (why this row exists as a reusable instance; surfaced in `## Content Library`), `values` keyed by the module's declared field names. " +
    "**When NOT to use:** if you're also creating the page and its modules, `build_page` does the whole assembly (modules + instances + placements) in one call — use that instead. For a single instance the singular tool is fine. " +
    "After minting, bind rows to placements via `set_placement_content` (or let `build_page` content.source='existing' bind them). " +
    'Typical call: `{instances: [{moduleId: "…", purpose: "Footer CTA shared across product pages", values: {cta_label: "Start free", cta_href: "/signup"}}, {moduleId: "…", values: {…}}]}`.',
  schema: contentInstancesCreateManySchema,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["instances"],
    properties: {
      instances: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["moduleId"],
          properties: {
            moduleId: { type: "string", format: "uuid" },
            slug: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" },
            displayName: { type: "string", minLength: 1, maxLength: 128 },
            purpose: { type: "string", maxLength: 1000 },
            values: { type: "object", additionalProperties: true },
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
      input,
    );
    if (!r.ok) {
      return {
        ok: false,
        content: `content_instances.create_many failed (whole batch rolled back): ${describeError(r.error)}`,
      };
    }
    const { contentInstanceIds } = r.value as { contentInstanceIds: string[] };
    return {
      ok: true,
      content:
        `${contentInstanceIds.length} content_instance(s) created in one transaction:\n` +
        contentInstanceIds.map((id, i) => `instances[${i}] → ${id}`).join("\n") +
        "\nBind them to placements via set_placement_content (or build_page content.source='existing').",
      value: { contentInstanceIds },
    };
  },
};
