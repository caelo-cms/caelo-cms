// SPDX-License-Identifier: MPL-2.0

/**
 * P10 — `translate_page`. Auto-dispatches Mode 1 / Mode 2 based on
 * whether a variant exists for (slug, target_locale). The AI sees one
 * tool regardless — the dispatcher picks the right op from the
 * variant's status, matching the dashboard's single-button UX-5.
 *
 * Result lands as DRAFT; the user must confirm via the publish flow.
 * The AI is told this in the description so it doesn't claim "done."
 */

import { execute } from "@caelo/query-api";
import { type TranslatePageToolInput, translatePageToolInput } from "@caelo/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const translatePageTool: ToolDefinitionWithHandler<TranslatePageToolInput> = {
  name: "translate_page",
  description:
    "Translate or update one page into one target locale. The mode (new translation vs. update) is auto-decided from the page's translation_status for that locale. " +
    "The result lands as a DRAFT page — DO NOT claim the translation is published. The user must confirm via the publish flow. " +
    "Inputs: pageId (the SOURCE page), targetLocale (the locale to translate INTO). " +
    "If the user asks to translate multiple pages or a whole locale at once, use `start_translation_job` instead.",
  schema: translatePageToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "targetLocale"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      targetLocale: { type: "string", pattern: "^[a-z]{2,3}(-[A-Za-z]{2,4})?$" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // Look up the variant's existing status so we know which mode to call.
    const diffResult = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "translation.compute_diff",
      input,
    );
    if (!diffResult.ok) {
      return {
        ok: false,
        content: `translate_page failed at diff step: ${describeError(diffResult.error)}`,
      };
    }
    const { variantPageId } = diffResult.value as {
      variantPageId: string | null;
    };
    const opName = variantPageId === null ? "translation.mode_1" : "translation.mode_2";

    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, opName, input);
    if (!r.ok) {
      return {
        ok: false,
        content: `translate_page (${opName}) failed: ${describeError(r.error)}`,
      };
    }
    if (opName === "translation.mode_1") {
      const v = r.value as { variantPageId: string; moduleCount: number; costMicrocents: number };
      return {
        ok: true,
        content:
          `Created draft variant page ${v.variantPageId} for locale ${input.targetLocale} ` +
          `with ${v.moduleCount} modules. Cost: ${(v.costMicrocents / 1e8).toFixed(4)} USD. ` +
          `The user must confirm via the publish flow before this goes live.`,
      };
    }
    const v = r.value as {
      variantPageId: string;
      blocksChanged: number;
      blocksAdded: number;
      blocksRemoved: number;
      costMicrocents: number;
    };
    return {
      ok: true,
      content:
        `Updated translation for ${input.targetLocale}: ${v.blocksChanged} blocks changed` +
        (v.blocksAdded > 0 ? `, ${v.blocksAdded} new source blocks not yet aligned` : "") +
        (v.blocksRemoved > 0 ? `, ${v.blocksRemoved} stale blocks remain in variant` : "") +
        `. Cost: ${(v.costMicrocents / 1e8).toFixed(4)} USD. The variant page (${v.variantPageId}) is now in 'up_to_date' status; user must confirm via the publish flow.`,
    };
  },
};
