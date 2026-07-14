// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.0 — AI tool: create_content_instance. Mints a reusable
 * content_instance for a module. Pair with `set_placement_content` to
 * bind it to one or more placements with sync_mode='synced'.
 */

import { execute } from "@caelo-cms/query-api";
import { createContentInstanceToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const createContentInstanceTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").CreateContentInstanceToolInput
> = {
  name: "create_content_instance",
  description:
    "Mint ONE shared, reusable content_instance for a module — used when the same content should appear identically on N pages (the site footer's copyright, a brand banner across product pages, a repeated CTA in the blog). **Prefer `create_content_instances` (plural) when minting more than one instance** — one transaction instead of N round-trips (§11 bulk-first) — and `build_page` when you're also creating the page/modules (its per-module `content` payload mints and binds in the same call). The new row is then bindable to N placements via `set_placement_content({syncMode:'synced'})` so editing it propagates everywhere bound. " +
    '**Required v0.12.0 input:** `purpose` — a one-line rationale for why this is a shared row ("The brand footer used across the whole marketing site", "Pricing CTA — appears at the bottom of every pricing-adjacent page"). The `## Content Library` block surfaces this so your future self can decide reuse vs fork without asking the operator. ' +
    "**When NOT to use:** for one-off per-page content, prefer `set_page_module_content` — that path auto-mints an unsynced (private) instance per placement, no shared semantics, no decision needed. Only mint a shared instance when reuse is the actual intent. " +
    "**Decision rule before calling:** check `## Content Library` first. If a row with the matching purpose + module + appropriate placement pattern already exists, BIND to it via `set_placement_content` instead of minting a new one. Duplicate shared rows defeat the point. " +
    "`values` keys are the module's declared field names (`{{fieldName}}` placeholders); `slug` is an optional kebab-case handle (must be unique per module) for easy AI-side reference.",
  schema: createContentInstanceToolInput,
  inputSchema: {
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
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "content_instances.create",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `content_instances.create failed: ${describeError(r.error)}` };
    }
    const { contentInstanceId } = r.value as { contentInstanceId: string };
    return {
      ok: true,
      content: `content_instance ${contentInstanceId} created${input.slug ? ` (slug=${input.slug})` : ""}. Bind it to placements via set_placement_content.`,
    };
  },
};
