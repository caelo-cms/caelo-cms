// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.6 — `set_template_layout`. Re-points a template to a different
 * layout. Cascades to every page using that template — they pick up
 * the new chrome on the next render. No-op snapshot at the page level
 * (the template snapshot via templates.update is the audit anchor).
 */

import { execute } from "@caelo/query-api";
import { setTemplateLayoutToolInput } from "@caelo/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface LayoutDetail {
  id: string;
  slug: string;
}

export const setTemplateLayoutTool: ToolDefinitionWithHandler<
  import("@caelo/shared").SetTemplateLayoutToolInput
> = {
  name: "set_template_layout",
  description:
    "Re-point a template to a different layout. Every page using the template adopts the new chrome on the next render. " +
    'Use when the user wants a page-type to switch between chrome variants (e.g. "make landing pages use the bare layout").',
  schema: setTemplateLayoutToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["templateId", "layoutSlug"],
    properties: {
      templateId: { type: "string", format: "uuid" },
      layoutSlug: { type: "string", minLength: 1, maxLength: 120 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.get", {
      slug: input.layoutSlug,
    });
    if (!got.ok) {
      return { ok: false, content: `layouts.get failed: ${describeError(got.error)}` };
    }
    const layout = (got.value as { layout: LayoutDetail | null }).layout;
    if (!layout) {
      return { ok: false, content: `layout "${input.layoutSlug}" not found` };
    }
    const upd = await execute(toolCtx.registry, toolCtx.adapter, ctx, "templates.update", {
      templateId: input.templateId,
      layoutId: layout.id,
    });
    if (!upd.ok) {
      return { ok: false, content: `templates.update failed: ${describeError(upd.error)}` };
    }
    return {
      ok: true,
      content: `template ${input.templateId} re-pointed to layout "${layout.slug}"; pages using this template will adopt the new chrome on the next render`,
    };
  },
};
