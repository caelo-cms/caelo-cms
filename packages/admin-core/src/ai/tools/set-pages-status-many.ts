// SPDX-License-Identifier: MPL-2.0

/**
 * v0.9.13 — AI tool: `set_pages_status_many`. Bulk variant of
 * `set_page_status`. Flips N pages' status in one transaction with the
 * same dual-write contract (live row + latest branched snapshot patch).
 *
 * Per CLAUDE.md §11: bulk variants of routine ops save N×round-trips,
 * N×token cycles, and N×tool-result events in chat. Prefer this over
 * iterating `set_page_status` whenever the user names >1 page.
 */

import { execute } from "@caelo-cms/query-api";
import { setPagesStatusManyToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import { stageReadinessSuffix } from "./_stage-readiness.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const setPagesStatusManyTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").SetPagesStatusManyToolInput
> = {
  name: "set_pages_status_many",
  description:
    "Set page status for 1..N pages — the only status tool ('publish this page', 'draft these four').\n" +
    "CORE RULES: drafts are editor-only, never shipped to Stage/Production. Status is sticky: other edits keep it. " +
    "Unknown/deleted ids are SKIPPED: compare result `updatedCount` to ids passed; fails only if NONE matched.",
  schema: setPagesStatusManyToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageIds", "status"],
    properties: {
      pageIds: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: { type: "string", format: "uuid" },
      },
      status: { type: "string", enum: ["draft", "published"] },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.set_status_many", input);
    if (!r.ok) {
      return { ok: false, content: `pages.set_status_many failed: ${describeError(r.error)}` };
    }
    const v = r.value as { updatedCount: number };
    // #678 — the status only reaches staging with a build: say so, with
    // the next step, so the AI does not report the pages as on staging.
    const next =
      input.status === "published"
        ? " They reach the staging site only with the next Stage — call stage_changes when the work is ready for review."
        : " They stay on staging / live until the next Stage / Publish live rebuilds without them.";
    return {
      ok: true,
      content: `${v.updatedCount} page(s) set to ${input.status}.${next}${await stageReadinessSuffix(ctx, toolCtx)}`,
    };
  },
};
