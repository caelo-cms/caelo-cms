// SPDX-License-Identifier: MPL-2.0

/**
 * P8 — `autofill_page_seo`. Fill-once contract: refuses when the
 * page's SEO was already autofilled. The `seo-autofill` skill calls
 * this on the first-publish path.
 */

import { execute } from "@caelo-cms/query-api";
import { autofillPageSeoToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const autofillPageSeoTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").AutofillPageSeoToolInput
> = {
  name: "autofill_page_seo",
  description:
    "Fill the per-page meta description (and optional og:image) for the FIRST time. " +
    "Use this only on draft pages whose SEO is unfilled. " +
    "Returns AlreadyAutofilled when the page's SEO was previously auto-filled — in that case, " +
    "ask the user whether they want to explicitly re-optimize via `optimize_page_seo`. " +
    "Aim for 50–60 char title (set via `update_pages_many`) and 150–160 char meta description.",
  schema: autofillPageSeoToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "metaDescription"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      metaDescription: { type: "string", minLength: 1, maxLength: 320 },
      ogImageAssetId: { type: ["string", "null"], format: "uuid" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages_seo.autofill", input);
    if (!r.ok) {
      return { ok: false, content: `pages_seo.autofill failed: ${describeError(r.error)}` };
    }
    return { ok: true, content: `SEO autofilled on page ${input.pageId}` };
  },
};
