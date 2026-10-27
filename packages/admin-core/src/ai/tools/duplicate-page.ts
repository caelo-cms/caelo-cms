// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.7 — `duplicate_page`. Clones an existing page (and its module
 * layout) under a new slug. Modules are referenced, not deep-copied:
 * editing one module updates every page that references it. The
 * duplicated page inherits the source page's templateId by default;
 * pass `targetTemplateId` to clone into a different page-type, but
 * note that block names must line up (mismatched names need a
 * follow-up `repoint_page_template` to migrate orphans).
 */

import { execute } from "@caelo-cms/query-api";
import { duplicatePageToolInput } from "@caelo-cms/shared";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

export const duplicatePageTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").DuplicatePageToolInput
> = {
  name: "duplicate_page",
  description:
    "Clone a page under a new slug ('duplicate the about page'). Modules are shared by reference (edits hit both). The copy keeps the source's parent (`/docs/a` -> `/docs/<newSlug>`), page type, properties and terms (change later via `update_pages_many`); soft-deleted source modules are dropped. " +
    "`targetTemplateId` of another page type -> the copy takes that type; block names must align, modules in unmatched blocks orphan -> fix with `repoint_page_template`.",
  schema: duplicatePageToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["sourcePageId", "newSlug"],
    properties: {
      sourcePageId: { type: "string", format: "uuid" },
      newSlug: { type: "string", minLength: 1, maxLength: 120 },
      newTitle: { type: "string", minLength: 1, maxLength: 256 },
      newShortTitle: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        description:
          "The copy's breadcrumb / navigation label. Omitted: newTitle when given, else the source's short title.",
      },
      targetTemplateId: { type: "string", format: "uuid" },
      newParentPageId: {
        type: ["string", "null"],
        format: "uuid",
        description: "null = top level; omit = source's parent.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const res = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.duplicate", input);
    if (!res.ok) {
      return { ok: false, content: `pages.duplicate failed: ${describeError(res.error)}` };
    }
    const newPageId = (res.value as { pageId: string }).pageId;
    return {
      ok: true,
      content: `page ${newPageId} cloned with slug=${input.newSlug}; modules carry over by reference (edits propagate to the source)`,
    };
  },
};
