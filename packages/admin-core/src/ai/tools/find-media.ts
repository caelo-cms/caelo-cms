// SPDX-License-Identifier: MPL-2.0

/**
 * P7 — `find_media`. Search the media library by alt / filename /
 * mime. Returns matches with the WebP-800 URL (or `orig` for
 * non-image kinds) pre-resolved so the AI can drop it straight into
 * an `<img src>` in module HTML via `edit_module`.
 *
 * The system prompt already carries the most-recent + most-used N
 * assets; this tool exists for the "I know what I want, search for
 * it" case where the asset isn't in that slice.
 */

import { execute } from "@caelo/query-api";
import { buildMediaUrl, findMediaToolInput, type MediaVariantTag } from "@caelo/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const RASTER_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);

export const findMediaTool: ToolDefinitionWithHandler<import("@caelo/shared").FindMediaToolInput> =
  {
    name: "find_media",
    description:
      "Search the media library and return matches as { id, alt, mime, width, height, url }. " +
      "Use when the user references an asset by description (e.g. 'the hero photo', 'the office image') " +
      "and you can't find a match in the ## Media block of the system prompt. " +
      "The returned URL is the WebP-800 variant for raster images, the `orig` variant otherwise — " +
      "drop it straight into an <img src> in module HTML via `edit_module`. " +
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
        }[];
      };
      if (assets.length === 0) {
        return {
          ok: true,
          content: `No media matched. Ask the user to upload via /content/media.`,
        };
      }
      const lines = assets.map((a) => {
        const variant: MediaVariantTag = RASTER_MIMES.has(a.mime) ? "webp-800" : "orig";
        const dims = a.width && a.height ? `, ${a.width}x${a.height}` : "";
        const alt = a.alt ? `, alt="${a.alt}"` : "";
        return `- ${a.originalName} (${a.mime}${dims}${alt}) → ${buildMediaUrl(a.id, variant)}`;
      });
      return { ok: true, content: `Matches:\n${lines.join("\n")}` };
    },
  };
