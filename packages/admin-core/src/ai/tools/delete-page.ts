// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: delete_page. Soft-deletes a page (sets `deleted_at`) plus
 * either lets the URL serve a 404 or creates a 301 redirect to a
 * caller-supplied target. The dispatcher Zod refines the input so
 * `disposition='redirect'` requires a `redirectTo`.
 *
 * The system prompt's tool guidance instructs the AI to suggest a
 * redirect target (parent section / sibling page / `/`) and confirm
 * with the user before invoking. No silent default behaviour for
 * dead URLs.
 */

import { execute } from "@caelo/query-api";
import { deletePageToolInput } from "@caelo/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface PageRow {
  id: string;
  slug: string;
  locale: string;
}

function pathFor(slug: string, locale: string): string {
  return locale === "en" ? `/${slug}` : `/${locale}/${slug}`;
}

export const deletePageTool: ToolDefinitionWithHandler<
  import("@caelo/shared").DeletePageToolInput
> = {
  name: "delete_page",
  description:
    "Soft-delete a page. Required `disposition`: '404' returns not-found, 'redirect' creates a 301 to `redirectTo`. " +
    "Always confirm with the user first which behaviour they want for the dead URL — suggest a sensible redirect target " +
    "(parent section, sibling page, or /) when proposing 'redirect'. Never silently leave dead URLs unredirected.",
  schema: deletePageToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "disposition"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      disposition: { type: "string", enum: ["404", "redirect"] },
      redirectTo: { type: "string", minLength: 1, maxLength: 500 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // Resolve old path before deleting so the redirect (if any) has
    // the right `fromPath`.
    let oldPath: string | null = null;
    const listR = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.list", {});
    if (listR.ok) {
      const page = (listR.value as { pages: PageRow[] }).pages.find((p) => p.id === input.pageId);
      if (page) oldPath = pathFor(page.slug, page.locale);
    }

    const del = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.delete", {
      pageId: input.pageId,
    });
    if (!del.ok) return { ok: false, content: `pages.delete failed: ${describeError(del.error)}` };

    if (input.disposition === "redirect") {
      if (!oldPath) {
        return {
          ok: false,
          content: "page deleted but old path could not be resolved — redirect not created",
        };
      }
      const red = await execute(toolCtx.registry, toolCtx.adapter, ctx, "redirects.create", {
        fromPath: oldPath,
        toPath: input.redirectTo!,
        statusCode: 301,
      });
      if (!red.ok)
        return {
          ok: false,
          content: `page deleted but redirects.create failed: ${describeError(red.error)}`,
        };
      return {
        ok: true,
        content: `page ${input.pageId} deleted; 301 ${oldPath} → ${input.redirectTo}`,
      };
    }
    return {
      ok: true,
      content: `page ${input.pageId} deleted; ${oldPath ?? "old URL"} now serves 404`,
    };
  },
};
