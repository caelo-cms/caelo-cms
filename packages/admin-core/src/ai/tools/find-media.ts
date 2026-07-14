// SPDX-License-Identifier: MPL-2.0

/**
 * P7 — `find_media`. Search the media library by alt / filename /
 * mime. Returns matches with a pre-resolved URL the AI can drop
 * straight into an `<img src>` in module HTML via `edit_module`.
 *
 * run #10 D4 — the URL variant is picked from the variants that
 * ACTUALLY exist on each asset (pickAiImageVariant): a sub-800px
 * source never gets a webp-800 row, and advertising one anyway made
 * the AI write unresolvable refs that failed the staging build.
 *
 * The system prompt already carries the most-recent + most-used N
 * assets; this tool exists for the "I know what I want, search for
 * it" case where the asset isn't in that slice.
 */

import { execute } from "@caelo-cms/query-api";
import { buildMediaUrl, findMediaToolInput, pickAiImageVariant } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const findMediaTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").FindMediaToolInput
> = {
  name: "find_media",
  description:
    "Search the media library and return matches as { id, alt, mime, width, height, url }. " +
    "Use when the user references an asset by description (e.g. 'the hero photo', 'the office image') " +
    "and you can't find a match in the ## Media block of the system prompt. " +
    "The returned URL always points at a variant that exists on the asset (best available WebP, " +
    "or `orig` for SVG/PDF/video and very small images) — drop it straight into an <img src> in " +
    "module HTML via `edit_module` and do NOT rewrite the variant segment to something else. " +
    "If no match is found, ask the user to upload the asset via /content/media.",
  schema: findMediaToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", maxLength: 256 },
      mime: {
        type: "string",
        enum: [
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/avif",
          "image/gif",
          "image/svg+xml",
          "application/pdf",
          "video/mp4",
        ],
      },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 15 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const res = await execute(toolCtx.registry, toolCtx.adapter, ctx, "media.list", {
      query: input.query,
      mime: input.mime,
      sort: "most_used",
      limit: input.limit,
      offset: 0,
    });
    if (!res.ok) {
      return { ok: false, content: `media.list failed: ${describeError(res.error)}` };
    }
    const { assets } = res.value as {
      assets: {
        id: string;
        mime: string;
        alt: string;
        width: number | null;
        height: number | null;
        originalName: string;
        variants: { variant: string }[];
      }[];
    };
    if (assets.length === 0) {
      return {
        ok: true,
        content: `No media matched. Ask the user to upload via /content/media.`,
      };
    }
    const lines = assets.map((a) => {
      const variant = pickAiImageVariant(a.variants.map((v) => v.variant));
      const dims = a.width && a.height ? `, ${a.width}x${a.height}` : "";
      const alt = a.alt ? `, alt="${a.alt}"` : "";
      return `- ${a.originalName} (${a.mime}${dims}${alt}) → ${buildMediaUrl(a.id, variant)}`;
    });
    return {
      ok: true,
      content: `Matches:\n${lines.join("\n")}`,
      // v0.6.0 alpha.3 — structured payload for W3 retryWithArgs.
      value: { assets },
    };
  },
};
