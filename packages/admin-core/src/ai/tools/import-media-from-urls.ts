// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: import_media_from_urls. The explicit, URL-driven way source
 * media enters a migration. The AI names the exact source-site asset
 * URLs (from `inspect_external_page`'s image inventory) and this tool
 * downloads each into Caelo's media library, returning the Caelo media
 * URLs to reference in `build_page`. Everything that could NOT be
 * imported comes back in a LOUD skipped list with a reason (CLAUDE.md
 * §2) so the model never claims a clean import while URLs still hotlink
 * the source host.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const importMediaFromUrlsInput = z
  .object({
    assets: z
      .array(
        z.object({
          url: z.string().url(),
          name: z.string().max(200).optional(),
        }),
      )
      .min(1)
      .max(50),
  })
  .strict();

export const importMediaFromUrlsTool: ToolDefinitionWithHandler<
  z.infer<typeof importMediaFromUrlsInput>
> = {
  name: "import_media_from_urls",
  description:
    "Import source-site images, mp4 video and other assets into the media library by exact absolute URL (from `inspect_external_page`'s image inventory). THE way source media enters a migration — never `find_media` (Caelo library, empty then), never ask the operator to upload.\n" +
    "- Batch every asset a page needs in ONE call.\n" +
    "- Returns per asset the Caelo media URL (reference it in `build_page`) + mediaId (`set_theme_asset`/`set_media_alt_many`).\n" +
    "- The result lists every URL NOT imported (too large, fetch failed, blocked type): report it to the operator verbatim; never claim a clean import while it is non-empty.",
  schema: importMediaFromUrlsInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["assets"],
    properties: {
      assets: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["url"],
          properties: {
            url: {
              type: "string",
              format: "uri",
            },
            name: {
              type: "string",
              description:
                'Short human label from role/alt (logo -> "SearchVIU logo", hero -> "SearchVIU hero"). Becomes the PUBLIC media URL slug (`/_caelo/media/searchviu-logo`): name it like a human, not a filename. Omit only when the asset has no clear role.',
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
      "imports.import_media_urls",
      input,
    );
    if (!r.ok) {
      return { ok: false, content: `imports.import_media_urls failed: ${describeError(r.error)}` };
    }
    const v = r.value as {
      imported: Array<{ sourceUrl: string; mediaId: string; slug: string; mediaUrl: string }>;
      skipped: Array<{ url: string; reason: string }>;
    };
    // Issue #411: the mediaId must be model-visible — set_theme_asset /
    // set_media_alt_many require the UUID and this content string is all the
    // model ever sees (the raw op value never enters the transcript).
    const lines: string[] = [
      `Imported ${v.imported.length} asset(s) into the media library. Reference these Caelo media URLs in build_page; bind theme slots / set alt text via the mediaId:`,
      ...v.imported.map((a) => `- ${a.sourceUrl} → ${a.mediaUrl} (mediaId ${a.mediaId})`),
    ];
    if (v.imported.length === 0) {
      lines[0] = "Imported 0 asset(s) — nothing entered the media library.";
    }
    // Honesty gate (CLAUDE.md §2): a non-empty skipped list means those
    // URLs still point at the source host and will break when it goes
    // away. Lead LOUD so it cannot read as a clean import.
    if (v.skipped.length > 0) {
      lines.push(
        `${v.skipped.length} URL(s) could NOT be imported — surface this list to the operator (these still point at the source site and will break when it goes away):`,
        ...v.skipped.map((s) => `- ${s.url} — ${s.reason}`),
      );
    }
    return { ok: true, content: lines.join("\n") };
  },
};
