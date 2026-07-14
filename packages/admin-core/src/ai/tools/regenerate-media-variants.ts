// SPDX-License-Identifier: MPL-2.0

/**
 * run #10 D4 — `regenerate_media_variants`. The staging generator
 * fails a build loudly when module HTML references an (asset, variant)
 * pair with no `media_variants` row; this tool is the recovery step
 * its error message points at. Wraps `media.regenerate_variants`.
 */

import { execute } from "@caelo-cms/query-api";
import { regenerateMediaVariantsToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const regenerateMediaVariantsTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").RegenerateMediaVariantsToolInput
> = {
  name: "regenerate_media_variants",
  description:
    "Re-run the image pipeline for media assets whose derived WebP variants are missing, and persist " +
    "any variant that can be produced. Use when a Stage/deploy fails with 'media references unresolved " +
    "(asset/variant pairs missing)' — pass the asset ids from that error as assetIds, or allMissing: true " +
    "to sweep the whole library. Additive only: existing variants are never touched. " +
    "Read each result: status 'regenerated' lists the new variants; 'skipped' explains why the variant " +
    "can NEVER exist (source narrower than the breakpoint, animated GIF, non-raster) — in that case " +
    "edit the module HTML to use the result's bestUrl (find referencing modules via the ## Media block " +
    "or media.list_usages) and do not retry regeneration. " +
    "Do NOT use this to create crops or resize images for layout reasons.",
  schema: regenerateMediaVariantsToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      assetIds: {
        type: "array",
        items: { type: "string", format: "uuid" },
        minItems: 1,
        maxItems: 100,
        description: "Asset ids to regenerate (take them from the deploy error message).",
      },
      allMissing: {
        type: "boolean",
        default: false,
        description: "Sweep every raster asset with an incomplete variant ladder instead.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const res = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "media.regenerate_variants",
      input,
    );
    if (!res.ok) {
      return {
        ok: false,
        content: `media.regenerate_variants failed: ${describeError(res.error)}`,
      };
    }
    const { results } = res.value as {
      results: {
        assetId: string;
        status: string;
        addedVariants: string[];
        reason: string | null;
        bestUrl: string | null;
      }[];
    };
    if (results.length === 0) {
      return { ok: true, content: "No assets with regenerable variant gaps found." };
    }
    const lines = results.map((r) => {
      const added = r.addedVariants.length > 0 ? ` added=[${r.addedVariants.join(", ")}]` : "";
      const reason = r.reason ? ` — ${r.reason}` : "";
      const best = r.bestUrl ? ` (use ${r.bestUrl})` : "";
      return `- ${r.assetId}: ${r.status}${added}${reason}${best}`;
    });
    return {
      ok: true,
      content: `Variant regeneration results:\n${lines.join("\n")}`,
      value: { results },
    };
  },
};
