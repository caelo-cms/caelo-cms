// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.6 / v0.2.14 — `set_site_defaults`. AI-callable per the §11.A
 * exception in `ops/site_defaults.ts` (existing pages keep their
 * pinned ids; the change only affects future creates that omit the
 * explicit ids; snapshot-revertable). The AI can resolve a request
 * like "make site-default the default layout" into a single tool
 * call without operator round-trips.
 *
 * Slugs are accepted (not ids) so the AI can pass natural names.
 */

import { execute } from "@caelo-cms/query-api";
import { setSiteDefaultsToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface LayoutDetail {
  id: string;
  slug: string;
}

interface TemplateDetail {
  id: string;
  slug: string;
}

export const setSiteDefaultsTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").SetSiteDefaultsToolInput
> = {
  name: "set_site_defaults",
  // 2026-07 — STATIC on purpose: tool definitions are part of Anthropic's
  // prompt-cache prefix, so state-dependent text here busted the cache on
  // every site change. Current values + valid slugs live in the volatile
  // `## Site defaults` / `## Layouts` context blocks (after the cache
  // breakpoints) and in get_site_defaults / list_layouts / list_templates.
  description:
    "Set the site-wide default layout and/or default template. New pages created without an explicit layout/template " +
    "fall back to these. SAFE TO CALL DIRECTLY — only affects future creates; existing pages keep their pinned ids. " +
    "Pass slugs (e.g. `home-template`, `site-default`), not UUIDs — current values and the valid slugs are in the " +
    "`## Site defaults` / `## Layouts` context blocks (or get_site_defaults / list_layouts / list_templates). " +
    "On the FIRST set both `defaultLayoutSlug` and `defaultTemplateSlug` are required; afterwards pass only the field you change. " +
    "With no layouts/templates on the site yet, bootstrap first (create_layout → create_template) — the op rejects loudly until then.",
  schema: setSiteDefaultsToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      defaultLayoutSlug: { type: "string", minLength: 1, maxLength: 120 },
      defaultTemplateSlug: { type: "string", minLength: 1, maxLength: 120 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    // Resolve slugs to ids via existing read ops first; that way slug
    // typos surface a clear "not found" rather than the op-level
    // ActorScopeRejected (which would mask the real issue).
    const currentRes = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "site_defaults.get",
      {},
    );
    if (!currentRes.ok) {
      return {
        ok: false,
        content: `site_defaults.get failed: ${describeError(currentRes.error)}`,
      };
    }
    const current = (
      currentRes.value as {
        defaults: { defaultLayoutId: string; defaultTemplateId: string } | null;
      }
    ).defaults;

    let layoutId = current?.defaultLayoutId;
    if (input.defaultLayoutSlug !== undefined) {
      const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.get", {
        slug: input.defaultLayoutSlug,
      });
      if (!got.ok) {
        return { ok: false, content: `layouts.get failed: ${describeError(got.error)}` };
      }
      const layout = (got.value as { layout: LayoutDetail | null }).layout;
      if (!layout) {
        return { ok: false, content: `layout "${input.defaultLayoutSlug}" not found` };
      }
      layoutId = layout.id;
    }

    let templateId = current?.defaultTemplateId;
    if (input.defaultTemplateSlug !== undefined) {
      const listed = await execute(toolCtx.registry, toolCtx.adapter, ctx, "templates.list", {});
      if (!listed.ok) {
        return { ok: false, content: `templates.list failed: ${describeError(listed.error)}` };
      }
      const tpl = (listed.value as { templates: TemplateDetail[] }).templates.find(
        (t) => t.slug === input.defaultTemplateSlug,
      );
      if (!tpl) {
        return { ok: false, content: `template "${input.defaultTemplateSlug}" not found` };
      }
      templateId = tpl.id;
    }

    if (!layoutId || !templateId) {
      return {
        ok: false,
        content:
          "site_defaults is empty and only one of layout/template was supplied — provide both on first set",
      };
    }

    const res = await execute(toolCtx.registry, toolCtx.adapter, ctx, "site_defaults.set", {
      defaultLayoutId: layoutId,
      defaultTemplateId: templateId,
    });
    if (!res.ok) {
      return { ok: false, content: `site_defaults.set failed: ${describeError(res.error)}` };
    }
    return {
      ok: true,
      content: `site defaults updated (layout=${input.defaultLayoutSlug ?? "unchanged"}, template=${
        input.defaultTemplateSlug ?? "unchanged"
      })`,
    };
  },
};
