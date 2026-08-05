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
    "Import specific source-site images, video (mp4), and other assets into the media library by their exact URLs (from inspect_external_page's image inventory). " +
    'Pass `assets: [{ url, name }]` — give EACH asset a short meaningful `name` from its role/alt (a logo → "SearchVIU logo", a hero image → "SearchVIU hero"): the name becomes the asset\'s PUBLIC URL (`/_caelo/media/searchviu-logo`), so name it like a human would, not like a filename; the id never appears in the URL. ' +
    "Returns per imported asset the Caelo media URL (reference it in build_page) AND the mediaId (pass it to set_theme_asset / set_media_alt). " +
    "Batch — pass every image a page needs in ONE call. " +
    "THIS is how source media enters a migration: never find_media (that searches the Caelo library, empty during a migration) and never ask the operator to upload. " +
    "The result lists every URL that could NOT be imported (too large, fetch failed, blocked content type) — report that list to the operator verbatim; never claim a clean import while it is non-empty.",
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
        description:
          "Every image a page needs, in one call. Each item is the exact absolute source asset URL plus a short meaningful name.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["url"],
          properties: {
            url: {
              type: "string",
              format: "uri",
              description:
                "The exact absolute source asset URL (from inspect_external_page's image inventory).",
            },
            name: {
              type: "string",
              description:
                'Short, meaningful, human label for the asset from its role/alt (logo → "SearchVIU logo", hero → "SearchVIU hero"). Becomes the public media URL slug; the id stays internal. Omit only when the asset has no clear role.',
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
    // set_media_alt require the UUID and this content string is all the
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
