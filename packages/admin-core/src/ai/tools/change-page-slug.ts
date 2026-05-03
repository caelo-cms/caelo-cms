// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: change_page_slug. The destructive one — changes the URL
 * path of a page. Auto-creates a 301 from the old slug → new slug by
 * default so existing inbound links survive. Also walks every
 * structured-set with hrefs (nav-menu / link-list, recursively into
 * nav-menu children) and rewrites any matching href in the same
 * transaction.
 *
 * `redirectFromOld='skip'` is allowed only when the user explicitly
 * says they don't want a redirect. The system prompt's tool guidance
 * pushes 'auto' as the default and asks before 'skip'.
 */

import { execute } from "@caelo-cms/query-api";
import { changePageSlugToolInput } from "@caelo-cms/shared";
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

export const changePageSlugTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").ChangePageSlugToolInput
> = {
  name: "change_page_slug",
  description:
    "Change a page's URL slug (the path in the URL). Auto-creates a 301 from the old URL by default so existing inbound links keep working. " +
    "Also rewrites every nav-menu / link-list item that pointed at the old URL. " +
    "Only call when the user explicitly mentions changing the URL / slug / path. For renaming the internal label, use `rename_page`.",
  schema: changePageSlugToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "newSlug"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      newSlug: { type: "string", minLength: 1, maxLength: 120 },
      redirectFromOld: { type: "string", enum: ["auto", "skip"] },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // Resolve the current slug + locale so we can build the redirect.
    const listR = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.list", {});
    if (!listR.ok)
      return { ok: false, content: `pages.list failed: ${describeError(listR.error)}` };
    const pages = (listR.value as { pages: PageRow[] }).pages;
    const page = pages.find((p) => p.id === input.pageId);
    if (!page) return { ok: false, content: `page ${input.pageId} not found` };
    if (page.slug === input.newSlug) {
      return { ok: true, content: `slug already ${input.newSlug} — nothing to do` };
    }
    const oldPath = pathFor(page.slug, page.locale);
    const newPath = pathFor(input.newSlug, page.locale);

    // Apply the slug change.
    const upd = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.update", {
      pageId: input.pageId,
      slug: input.newSlug,
    });
    if (!upd.ok) return { ok: false, content: `pages.update failed: ${describeError(upd.error)}` };

    // Rewrite every nav-menu / link-list href in the same transaction
    // boundary as the redirect insert. Rewrites happen via the op
    // handler → DB; the op's recordAudit covers each touched set.
    const sets = await execute(toolCtx.registry, toolCtx.adapter, ctx, "structured_sets.list", {});
    let rewritten = 0;
    if (sets.ok) {
      const allSets = (
        sets.value as {
          sets: { id: string; kind: string; slug: string; displayName: string; items: unknown }[];
        }
      ).sets;
      for (const s of allSets) {
        if (s.kind !== "nav-menu" && s.kind !== "link-list") continue;
        const items = s.items as unknown[];
        const next = rewriteHrefs(items, oldPath, newPath);
        if (next.changed) {
          const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "structured_sets.set", {
            kind: s.kind as "nav-menu" | "link-list",
            slug: s.slug,
            displayName: s.displayName,
            items: next.items,
          });
          if (r.ok) rewritten += 1;
        }
      }
    }

    if (input.redirectFromOld !== "skip") {
      const red = await execute(toolCtx.registry, toolCtx.adapter, ctx, "redirects.create", {
        fromPath: oldPath,
        toPath: newPath,
        statusCode: 301,
      });
      if (!red.ok)
        return { ok: false, content: `redirects.create failed: ${describeError(red.error)}` };
    }

    // P8 — rewrite every module's <a href="/<oldSlug>...">. The
    // structured-set rewriter above covers nav-menus + link-lists;
    // this covers the long tail of links inside module HTML bodies
    // (CTAs, inline mentions, footer link cards) so a slug change
    // doesn't strand any in-page link. System-actor op so the
    // updates pass RLS regardless of the current ai/human ctx.
    const moduleRewrite = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      { ...ctx, actorKind: "system" },
      "pages.rewrite_module_links",
      { oldSlug: page.slug, newSlug: input.newSlug },
    );
    const rewrittenModules = moduleRewrite.ok
      ? (moduleRewrite.value as { rewrittenModuleIds: string[] }).rewrittenModuleIds.length
      : 0;

    return {
      ok: true,
      content: `slug changed: ${oldPath} → ${newPath}; rewrote ${rewritten} nav/link set${rewritten === 1 ? "" : "s"} + ${rewrittenModules} module body link${rewrittenModules === 1 ? "" : "s"}; redirect ${input.redirectFromOld === "skip" ? "skipped" : "created (301)"}`,
    };
  },
};

interface HrefRewriteResult {
  items: unknown[];
  changed: boolean;
}
function rewriteHrefs(items: unknown[], oldPath: string, newPath: string): HrefRewriteResult {
  let changed = false;
  const next = items.map((it) => {
    if (!it || typeof it !== "object") return it;
    const obj = it as Record<string, unknown>;
    const out: Record<string, unknown> = { ...obj };
    if (typeof obj["href"] === "string" && obj["href"] === oldPath) {
      out["href"] = newPath;
      changed = true;
    }
    if (Array.isArray(obj["children"])) {
      const child = rewriteHrefs(obj["children"] as unknown[], oldPath, newPath);
      if (child.changed) {
        out["children"] = child.items;
        changed = true;
      }
    }
    return out;
  });
  return { items: next, changed };
}
