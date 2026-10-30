// SPDX-License-Identifier: MPL-2.0

/**
 * `remove_module_from` — the ONE module-removal tool, routed by `target`
 * (page | layout). Un-placement mirror of `add_module`: `targetRef` is a slug
 * OR a uuid, resolved server-side. Removing a module from a page/layout does
 * NOT delete the module row — it stays available for reuse elsewhere.
 *
 *   - page:   pages.get_with_modules → splice the moduleId out of every block →
 *             pages.set_modules.
 *   - layout: layouts.get → for each block, layout_modules.get/set with the
 *             moduleId filtered out (a layout module can sit in several blocks).
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { type RemoveModuleFromToolInput, removeModuleFromToolInput } from "@caelo-cms/shared";
import { describeError, toolError } from "./_describe-error.js";
import { resolvePageRef } from "./_page-ref.js";
import type { ToolContext, ToolDefinitionWithHandler, ToolResult } from "./dispatch.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageWithModules {
  id: string;
  blocks: { blockName: string; modules: { moduleId: string }[] }[];
}
interface LayoutDetail {
  id: string;
  slug: string;
  blocks: { name: string }[];
}

export const removeModuleFromTool: ToolDefinitionWithHandler<RemoveModuleFromToolInput> = {
  name: "remove_module_from",
  description:
    'Remove a module reference from a page or layout; the module itself stays for reuse. `target:"page"` drops the page-level reference (any block); `target:"layout"` detaches site-wide chrome from every block of the layout (\'remove the footer from every page\'). To replace a module, PREFER `update_modules_many` (keeps the slot) over remove + add.',
  schema: removeModuleFromToolInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["target", "targetRef", "moduleId"],
    properties: {
      target: { type: "string", enum: ["page", "layout"] },
      targetRef: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "Page: id or URL path (e.g. `/docs/setup`). Layout: slug or id.",
      },
      moduleId: { type: "string", format: "uuid" },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    return input.target === "page"
      ? removeFromPage(ctx, toolCtx, input)
      : removeFromLayout(ctx, toolCtx, input);
  },
};

async function removeFromPage(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  input: RemoveModuleFromToolInput,
): Promise<ToolResult> {
  const pageRef = await resolvePageRef(ctx, toolCtx, input.targetRef);
  if (!pageRef.ok) return { ok: false, content: pageRef.message };
  const pageId = pageRef.pageId;
  const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.get_with_modules", {
    pageId,
  });
  if (!got.ok)
    return toolError(got.error, `pages.get_with_modules failed: ${describeError(got.error)}`);
  const page = (got.value as { page: PageWithModules }).page;
  let removed = false;
  const blocks = page.blocks.map((b) => {
    const moduleIds = b.modules.map((m) => m.moduleId).filter((id) => id !== input.moduleId);
    if (moduleIds.length !== b.modules.length) removed = true;
    return { blockName: b.blockName, moduleIds };
  });
  if (!removed) return { ok: false, content: `module ${input.moduleId} is not on page ${pageId}` };
  const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.set_modules", {
    pageId,
    blocks,
  });
  if (!r.ok) return toolError(r.error, `pages.set_modules failed: ${describeError(r.error)}`);
  return { ok: true, content: `module ${input.moduleId} removed from page ${pageId}` };
}

async function removeFromLayout(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  input: RemoveModuleFromToolInput,
): Promise<ToolResult> {
  const slug = await resolveLayoutSlug(ctx, toolCtx, input.targetRef);
  const got = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.get", { slug });
  if (!got.ok) return toolError(got.error, `layouts.get failed: ${describeError(got.error)}`);
  const layout = (got.value as { layout: LayoutDetail | null }).layout;
  if (!layout) return refNotFound("layout", input.targetRef);
  let removed = 0;
  for (const block of layout.blocks) {
    const existing = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layout_modules.get", {
      layoutId: layout.id,
      blockName: block.name,
    });
    if (!existing.ok) continue;
    const ids = (existing.value as { moduleIds: string[] }).moduleIds;
    if (!ids.includes(input.moduleId)) continue;
    const setRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layout_modules.set", {
      layoutId: layout.id,
      blockName: block.name,
      moduleIds: ids.filter((id) => id !== input.moduleId),
    });
    if (setRes.ok) removed += 1;
  }
  if (removed === 0) {
    return {
      ok: false,
      content: `module ${input.moduleId} not attached to any block on layout "${layout.slug}"`,
    };
  }
  return {
    ok: true,
    content: `module ${input.moduleId} detached from ${removed} block(s) on layout "${layout.slug}"`,
  };
}

function refNotFound(target: string, ref: string): ToolResult {
  return {
    ok: false,
    content: `no ${target} found for targetRef "${ref}" — pass a valid slug or uuid (list_pages / list_layouts).`,
  };
}

async function resolveLayoutSlug(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  ref: string,
): Promise<string> {
  if (!UUID_RE.test(ref)) return ref;
  const listed = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layouts.list", {});
  if (!listed.ok) return ref;
  return (
    (listed.value as { layouts: { id: string; slug: string }[] }).layouts.find((l) => l.id === ref)
      ?.slug ?? ref
  );
}
