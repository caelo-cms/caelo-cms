// SPDX-License-Identifier: MPL-2.0

/**
 * v0.10.22 — AI tool: list_structured_sets. Thin wrapper over the
 * `structured_sets.list` op. The system-prompt block at session start
 * already shows existing sets + (for nav-menus, up to 30 items) their
 * inlined items; this tool exists for mid-conversation refresh after
 * writes and for non-nav-menu kinds where the prompt block shows
 * counts only.
 *
 * Part of the unified structured-sets CRUD surface: list / get / set /
 * delete. v0.10.22 replaced the kind-specific wrappers (`set_nav_menu`,
 * `update_theme`) with this generic API.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const listStructuredSetsToolInput = z
  .object({
    kind: z
      .enum(["nav-menu", "taxonomy", "tags", "link-list", "language-selector"])
      .optional(),
  })
  .strict();

type ListStructuredSetsToolInput = z.infer<typeof listStructuredSetsToolInput>;

export const listStructuredSetsTool: ToolDefinitionWithHandler<ListStructuredSetsToolInput> = {
  name: "list_structured_sets",
  description:
    "List structured-data sets on this site. Pass `kind` to filter (nav-menu, tags, taxonomy, link-list, language-selector); omit to return all kinds. " +
    "The system-prompt block above already shows existing sets at session start; call this only if you need fresh state after a write or if the prompt block was truncated. " +
    "Theme tokens are not structured sets (v0.11.0+) — use `list_themes` / `get_theme` instead.",
  schema: listStructuredSetsToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: {
        enum: ["nav-menu", "tags", "taxonomy", "link-list", "language-selector"],
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "structured_sets.list", input);
    if (!r.ok) {
      return { ok: false, content: `structured_sets.list failed: ${describeError(r.error)}` };
    }
    const sets = (
      r.value as {
        sets: { kind: string; slug: string; displayName: string; items: unknown }[];
      }
    ).sets;
    if (sets.length === 0) {
      return {
        ok: true,
        content: input.kind
          ? `No structured sets of kind '${input.kind}' on this site.`
          : "No structured sets on this site yet.",
      };
    }
    const lines = sets.map((s) => {
      const itemCount = Array.isArray(s.items) ? s.items.length : 0;
      return `- ${s.kind}/${s.slug} ("${s.displayName}") — ${itemCount} item${itemCount === 1 ? "" : "s"}`;
    });
    return { ok: true, content: lines.join("\n") };
  },
};
