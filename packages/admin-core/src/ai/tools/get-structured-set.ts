// SPDX-License-Identifier: MPL-2.0

/**
 * v0.10.22 — AI tool: get_structured_set. Thin wrapper over the
 * `structured_sets.get` op. Returns the items array for one set
 * identified by `kind` + `slug`. Use this to refresh the AI's view of
 * a specific set before doing a partial update (the `set` tool is
 * full-replace, so the typical workflow for "rename one menu item
 * without losing others" is: get → mutate → set).
 *
 * v0.11.0 (#45) — theme is no longer a structured-set kind; use
 * `get_theme` / `set_theme_tokens` for theme reads + writes.
 *
 * Part of the unified structured-sets CRUD surface: list / get / set /
 * delete.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const getStructuredSetToolInput = z
  .object({
    kind: z.enum(["nav-menu", "taxonomy", "tags", "link-list", "language-selector"]),
    slug: z.string().min(1).max(120),
  })
  .strict();

type GetStructuredSetToolInput = z.infer<typeof getStructuredSetToolInput>;

export const getStructuredSetTool: ToolDefinitionWithHandler<GetStructuredSetToolInput> = {
  name: "get_structured_set",
  description:
    "Fetch one structured-data set's current items by `kind` + `slug`. " +
    "Use this when (1) the system-prompt block didn't inline the items (>30 cap, or non-nav-menu kind) and you need to extend an existing set, or (2) you're doing a partial update (single link rename) and need the current state before `set_structured_set` to merge in JS. " +
    "Theme tokens are NOT a structured-set kind (v0.11.0+) — use `get_theme` / `set_theme_tokens` instead. " +
    "Returns null in the set field if no row exists for that kind+slug.",
  schema: getStructuredSetToolInput,
  inputSchema: z.toJSONSchema(getStructuredSetToolInput) as Record<string, unknown>,
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "structured_sets.get", input);
    if (!r.ok) {
      return { ok: false, content: `structured_sets.get failed: ${describeError(r.error)}` };
    }
    const set = (
      r.value as {
        set: { kind: string; slug: string; displayName: string; items: unknown } | null;
      }
    ).set;
    if (!set) {
      // Miss → answer with the kind's inventory INLINE so the model
      // corrects a slug typo in ONE step instead of a list round-trip.
      const listR = await execute(toolCtx.registry, toolCtx.adapter, ctx, "structured_sets.list", {
        kind: input.kind,
      });
      const existing = listR.ok
        ? (listR.value as { sets: { slug: string }[] }).sets.map((s) => s.slug)
        : [];
      const inventory =
        existing.length > 0
          ? ` Existing ${input.kind} sets: ${existing.join(", ")} — retry with one of these, or`
          : " No sets of this kind exist yet —";
      return {
        ok: true,
        content: `No set found for ${input.kind}/${input.slug}.${inventory} call set_structured_set with the same kind+slug to create it.`,
      };
    }
    return {
      ok: true,
      content: JSON.stringify(
        {
          kind: set.kind,
          slug: set.slug,
          displayName: set.displayName,
          items: set.items,
        },
        null,
        2,
      ),
    };
  },
};
