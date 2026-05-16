// SPDX-License-Identifier: MPL-2.0

/**
 * v0.5.12 — `list_templates`. AI-callable wrapper around
 * `templates.list`. Mirrors `list_layouts`; see that file's doc for
 * why these on-demand read tools exist alongside the system-prompt
 * context blocks.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const listTemplatesInput = z
  .object({
    includeDeleted: z.boolean().default(false),
  })
  .strict();
type ListTemplatesInput = z.infer<typeof listTemplatesInput>;

export const listTemplatesTool: ToolDefinitionWithHandler<ListTemplatesInput> = {
  name: "list_templates",
  description:
    "List every template on the site with its UUID, slug, display name, and bound layout UUID. " +
    "Use when you need a template UUID and don't see it in the `# Templates → layouts` context block " +
    "(e.g. immediately after create_template returned successfully — the tool result doesn't echo the UUID; fetch it via this tool). " +
    "DO NOT ask the operator to paste a UUID — call this tool.",
  schema: listTemplatesInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      includeDeleted: { type: "boolean", default: false },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "templates.list", input);
    if (!r.ok) {
      return { ok: false, content: `templates.list failed: ${describeError(r.error)}` };
    }
    const templates = (
      r.value as {
        templates: { id: string; slug: string; displayName: string; layoutId: string }[];
      }
    ).templates;
    if (templates.length === 0) {
      return {
        ok: true,
        content:
          "No templates on this site yet. Call create_template (pass layoutId from list_layouts) to create one.",
      };
    }
    const lines = templates.map(
      (t) => `- ${t.slug} (id=${t.id}) "${t.displayName}" → layoutId=${t.layoutId}`,
    );
    return {
      ok: true,
      content: `${templates.length} template${templates.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
      // v0.6.0 alpha.2 — structured payload for the W3 retry path.
      // Used by pages.create's nextAction.retryWithArgs to extract
      // templates[0].id and re-dispatch the failed pages.create.
      value: { templates },
    };
  },
};
