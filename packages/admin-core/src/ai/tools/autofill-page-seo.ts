// SPDX-License-Identifier: MPL-2.0

/**
 * P8 — `autofill_page_seo` + its bulk variant `autofill_page_seo_many`.
 * Fill-once contract: refuses when the page's SEO was already autofilled.
 * The AI writes every new page's meta description with these before the
 * page's first Stage — staging and production builds refuse pages without
 * one (deploy/missing-seo.ts), so this is the step that unblocks them.
 */

import { execute } from "@caelo-cms/query-api";
import { type AutofillPageSeoToolInput, autofillPageSeoToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import { makeBulkTool } from "./_make-bulk-tool.js";
import { stageReadinessSuffix } from "./_stage-readiness.js";
import type { ToolDefinitionWithHandler, ToolInputSchema } from "./dispatch.js";

const autofillItemJsonSchema: ToolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["pageId", "metaDescription"],
  properties: {
    pageId: { type: "string", format: "uuid" },
    metaDescription: { type: "string", minLength: 1, maxLength: 320 },
    ogImageAssetId: { type: ["string", "null"], format: "uuid" },
  },
};

export const autofillPageSeoTool: ToolDefinitionWithHandler<AutofillPageSeoToolInput> = {
  name: "autofill_page_seo",
  description:
    "Write a page's meta description (and optional og:image) for the FIRST time. " +
    "Every new page needs one before it is Staged — a Stage refuses pages without one. " +
    "Write it from the page's actual content (or carry over the source page's description when migrating a site). " +
    "Prefer `autofill_page_seo_many` when more than one page needs it. " +
    "For a page you create with build_page, pass `page.metaDescription` there instead — same fill-once write, no extra call. " +
    "Fill-once: sending the SAME text again is a harmless no-op; a DIFFERENT text for an already-filled page returns AlreadyAutofilled with the stored description (the page is not missing one) — change it on purpose only via `optimize_page_seo`, and only when the user asks. " +
    "Aim for 50–60 char title (set via `update_pages_many`) and 150–160 char meta description.",
  schema: autofillPageSeoToolInput,
  inputSchema: autofillItemJsonSchema,
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages_seo.autofill", input);
    if (!r.ok) {
      return { ok: false, content: `pages_seo.autofill failed: ${describeError(r.error)}` };
    }
    const v = r.value as { alreadyFilled?: boolean };
    const what = v.alreadyFilled
      ? `page ${input.pageId} already had exactly this meta description — nothing changed`
      : `SEO autofilled on page ${input.pageId}`;
    return { ok: true, content: `${what}.${await stageReadinessSuffix(ctx, toolCtx)}` };
  },
};

export const autofillPageSeoManyTool = makeBulkTool({
  name: "autofill_page_seo_many",
  description:
    "Write the FIRST meta description for SEVERAL pages in ONE transaction — prefer this over multiple `autofill_page_seo` calls (§11 bulk-first). " +
    "Use it after building pages and before Staging them: a Stage refuses pages without a meta description and names them. " +
    "Write each description from that page's actual content (150–160 characters, for a human reading a search result), or carry over the source page's description when migrating a site. " +
    "All-or-nothing: a page already autofilled with a DIFFERENT text (AlreadyAutofilled) aborts the whole batch — leave such pages out (the same text again is a no-op); their descriptions change through `optimize_page_seo` / `bulk_optimize_seo` (re-optimization) or `set_page_seo_many` (an exact value the user dictated). " +
    "Each item is the `autofill_page_seo` shape: `{pageId, metaDescription, ogImageAssetId?}`.",
  itemInputSchema: autofillPageSeoToolInput,
  itemJsonSchema: autofillItemJsonSchema,
  opName: "pages_seo.autofill_many",
  resultSuffix: stageReadinessSuffix,
});
