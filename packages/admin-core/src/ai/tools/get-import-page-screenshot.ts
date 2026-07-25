// SPDX-License-Identifier: MPL-2.0

/**
 * issue #198 — let the model LOOK at the original site while
 * rebuilding it. Returns the stored crawl screenshot of the live
 * original as an image part via the established result.image path.
 * This is what makes keep-design repair rounds honest: the AI compares
 * against pixels, not against its memory of the inventory.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { getMediaStorage } from "../../media/storage.js";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const input = z
  .object({
    importPageId: z.string().uuid(),
  })
  .strict();
type Input = z.infer<typeof input>;

export const getImportPageScreenshotTool: ToolDefinitionWithHandler<Input> = {
  name: "get_import_page_screenshot",
  description:
    "See a crawled import page's stored screenshot of the ORIGINAL live site (at crawl time) as an image, attached to your next turn — your keep-design reference. Use it as a visual self-check while rebuilding to compare your rebuild against real pixels. Requires the crawl worker to have run with screenshots enabled — a missing screenshot is reported honestly (do NOT claim you saw it). For pages on Caelo itself use `screenshot_page`; for arbitrary live URLs use `screenshot_external_page`.",
  schema: input,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["importPageId"],
    properties: {
      importPageId: { type: "string", format: "uuid" },
    },
  },
  handler: async (ctx, toolInput, toolCtx) => {
    const r = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "imports.get_page_screenshot_keys",
      { importPageId: toolInput.importPageId },
    );
    if (!r.ok) {
      return {
        ok: false,
        content: `get_import_page_screenshot failed: ${describeError(r.error)}`,
      };
    }
    const keys = r.value as {
      sourceUrl: string | null;
      screenshotObjectKey: string | null;
    };
    const key = keys.screenshotObjectKey;
    if (!key) {
      return {
        ok: false,
        content:
          "No source screenshot is stored for this page (the crawl worker ran without screenshot capture). Tell the operator you cannot compare visually for this page — do not pretend you saw it.",
      };
    }
    try {
      const bytes = await getMediaStorage().get(key);
      return {
        ok: true,
        content: `Original-site screenshot for ${keys.sourceUrl ?? toolInput.importPageId} attached to the next turn.`,
        image: { base64: Buffer.from(bytes).toString("base64"), mediaType: "image/png" },
      };
    } catch (e) {
      return {
        ok: false,
        content: `Screenshot object ${key} is missing from storage: ${e instanceof Error ? e.message : String(e)}.`,
      };
    }
  },
};
