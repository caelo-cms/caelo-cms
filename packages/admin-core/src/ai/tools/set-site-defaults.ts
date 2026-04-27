// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.6 — `set_site_defaults`. Owner-only at the op level. AI calls
 * reject with ActorScopeRejected and the chat surfaces a permission
 * message. The tool exists so the AI can recognize "make the bare
 * layout the default" as a request and explain that the user (Owner)
 * needs to make the change in /security/site-defaults.
 *
 * Slugs are accepted (not ids) so the AI can pass natural names.
 */

import { execute } from "@caelo/query-api";
import { setSiteDefaultsToolInput } from "@caelo/shared";
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
  import("@caelo/shared").SetSiteDefaultsToolInput
> = {
  name: "set_site_defaults",
  description:
    "Change the site-wide default layout and/or default template. New pages created without an explicit layout/template " +
    "fall back to these. Owner-only — AI calls reject with a permission message; the user must change defaults via " +
    "/security/site-defaults. Pass slugs, not ids.",
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
      const errKind = (res.error as { kind?: string }).kind;
      if (errKind === "ActorScopeRejected") {
        return {
          ok: false,
          content:
            "changing site defaults requires Owner permission. Ask an Owner to update them via /security/site-defaults.",
        };
      }
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
