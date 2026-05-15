// SPDX-License-Identifier: MPL-2.0

/**
 * AI tool: add_module_to_page. Creates a new module and inserts it into
 * a target page's block at a chosen position ("top" | "bottom" | index).
 * The handler chains three Query API ops:
 *
 *   1. modules.create — make the module (the Zod validator and snapshot
 *      emission run here exactly as they do for human module creation).
 *   2. pages.get_with_modules — read the existing layout.
 *   3. pages.set_modules — splice the new moduleId into the requested
 *      block at the requested position.
 *
 * Each op fires its own audit + snapshot row; the tool result reports
 * the new moduleId so the AI can refer to it in follow-up turns.
 */

import { execute } from "@caelo-cms/query-api";
import { addModuleToPageToolInput } from "@caelo-cms/shared";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

interface PageWithModules {
  id: string;
  templateId: string;
  blocks: { blockName: string; modules: { moduleId: string }[] }[];
}

function describeError(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const e = error as { kind?: string; message?: string; issues?: unknown[]; detail?: string };
  if (e.kind === "ValidationFailed" && Array.isArray(e.issues)) {
    return `validation: ${e.issues
      .slice(0, 3)
      .map((i) => {
        const z = i as { path?: unknown[]; message?: string };
        return `${(z.path ?? []).join(".")}: ${z.message ?? "?"}`;
      })
      .join("; ")}`;
  }
  if (typeof e.message === "string") return e.message;
  if (typeof e.detail === "string") return e.detail;
  return e.kind ?? "unknown";
}

function slugify(displayName: string): string {
  const base = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const stem = base.length > 0 ? base : "module";
  return `${stem}-${Date.now().toString(36)}`;
}

export const addModuleToPageTool: ToolDefinitionWithHandler<
  import("@caelo-cms/shared").AddModuleToPageToolInput
> = {
  name: "add_module_to_page",
  description:
    "Create a new module (HTML, optional CSS/JS) and place it in one of the page's blocks at the chosen position. " +
    "Use when the user asks to add NEW content (a button, a banner, a menu, a section) — not when they want to change " +
    "an existing module (use edit_module for that). " +
    "For chrome that should appear on every page, use add_module_to_layout instead; for every page on a template, use add_module_to_template. " +
    'NOTE on `position`: pass the literal string "top" or "bottom", OR a bare integer (0, 1, 2…). ' +
    'Quoted-string numbers like "0" fail validation — pass `0` not `"0"`.',
  schema: addModuleToPageToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId", "blockName", "position", "displayName", "html"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      blockName: { type: "string", minLength: 1, maxLength: 80 },
      position: {
        oneOf: [
          { type: "string", enum: ["top", "bottom"] },
          { type: "integer", minimum: 0, maximum: 1000 },
        ],
      },
      displayName: { type: "string", minLength: 1, maxLength: 128 },
      html: { type: "string", minLength: 1, maxLength: 50_000 },
      css: { type: "string", maxLength: 50_000 },
      js: { type: "string", maxLength: 50_000 },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    const slug = slugify(input.displayName);
    const created = await execute(toolCtx.registry, toolCtx.adapter, ctx, "modules.create", {
      slug,
      displayName: input.displayName,
      html: input.html,
      css: input.css ?? "",
      js: input.js ?? "",
    });
    if (!created.ok) {
      return {
        ok: false,
        content: `modules.create failed: ${describeError(created.error)}`,
      };
    }
    const newModuleId = (created.value as { moduleId: string }).moduleId;

    const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.get_with_modules", {
      pageId: input.pageId,
    });
    if (!got.ok) {
      return {
        ok: false,
        content: `pages.get_with_modules failed: ${describeError(got.error)}`,
      };
    }
    const page = (got.value as { page: PageWithModules }).page;
    const targetBlock = page.blocks.find((b) => b.blockName === input.blockName);
    if (!targetBlock) {
      const allowed = page.blocks.map((b) => b.blockName).join(", ");
      return {
        ok: false,
        content: `block "${input.blockName}" does not exist on this page's template. Available blocks: ${allowed}`,
      };
    }

    const existingIds = targetBlock.modules.map((m) => m.moduleId);
    const insertIdx =
      input.position === "top"
        ? 0
        : input.position === "bottom"
          ? existingIds.length
          : Math.min(input.position, existingIds.length);
    const newBlockIds = [
      ...existingIds.slice(0, insertIdx),
      newModuleId,
      ...existingIds.slice(insertIdx),
    ];

    const blocks = page.blocks.map((b) =>
      b.blockName === input.blockName
        ? { blockName: b.blockName, moduleIds: newBlockIds }
        : { blockName: b.blockName, moduleIds: b.modules.map((m) => m.moduleId) },
    );
    const setRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.set_modules", {
      pageId: input.pageId,
      blocks,
    });
    if (!setRes.ok) {
      return {
        ok: false,
        content: `pages.set_modules failed: ${describeError(setRes.error)}`,
      };
    }
    return {
      ok: true,
      content: `module ${newModuleId} (slug=${slug}) added to block "${input.blockName}" at position ${insertIdx}`,
    };
  },
};
