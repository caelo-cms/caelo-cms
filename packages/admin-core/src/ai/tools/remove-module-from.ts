// SPDX-License-Identifier: MPL-2.0

/**
 * `remove_module_from` — the ONE module-removal tool, routed by `target`
 * (page | layout). Un-placement mirror of `add_module`: `targetRef` is a slug
 * OR a uuid, resolved server-side. Removing a module from a page/layout does
 * NOT delete the module row — it stays available for reuse elsewhere.
 *
 *   - page:   pages.get_with_modules → drop the addressed placement(s) →
 *             pages.set_modules, naming every survivor's content instance.
 *   - layout: layouts.get → layout_modules.get per block → layout_modules.set
 *             for each block that loses a placement.
 *
 * #1663 — it removes the placement it is told to, never "every placement of
 * this module". A module the target holds more than once needs `blockName` +
 * `position` (the address `set_placement_content` and `move_module` use), or
 * an explicit `allPlacements: true`; otherwise the call is refused with the
 * placements listed, each with a preview of its content so the AI can pick
 * the right one without asking the operator. Survivors are handed to
 * set_modules by content instance: its per-(block, module) FIFO matching
 * would otherwise give the removed placement's content to the one that stays.
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
  blocks: {
    blockName: string;
    modules: {
      moduleId: string;
      contentInstanceId: string | null;
      syncMode: "synced" | "unsynced";
    }[];
  }[];
}
interface LayoutDetail {
  id: string;
  slug: string;
  blocks: { name: string }[];
}

/** One placement of the module being removed: where it sits on the target. */
export interface PlacementAt {
  readonly blockName: string;
  readonly position: number;
}

/** "block "content" position 2". */
function at(p: PlacementAt): string {
  return `block "${p.blockName}" position ${p.position}`;
}

/**
 * The placements of the module the call removes, or the refusal that says
 * which address to send instead. Pure: `found` is every placement of the
 * module on the target, in block + position order; `describe` renders one
 * placement for a refusal (a page adds its content preview).
 */
export function pickPlacements<P extends PlacementAt>(
  found: readonly P[],
  input: Pick<RemoveModuleFromToolInput, "blockName" | "position" | "allPlacements">,
  describe: (p: P) => string,
):
  | { readonly ok: true; readonly picked: readonly P[] }
  | { readonly ok: false; readonly message: string } {
  const list = found.map(describe).join("; ");
  if (input.allPlacements === true && input.position !== undefined) {
    return {
      ok: false,
      message: `allPlacements removes every placement${input.blockName !== undefined ? ` in block "${input.blockName}"` : ""}, so it takes no position. Drop position to remove them all, or drop allPlacements to remove only the one at position ${input.position}. Placements: ${list}.`,
    };
  }
  const addressed = found.filter(
    (p) =>
      (input.blockName === undefined || p.blockName === input.blockName) &&
      (input.position === undefined || p.position === input.position),
  );
  if (addressed.length === 0) {
    const asked = [
      input.blockName !== undefined ? `block "${input.blockName}"` : "",
      input.position !== undefined ? `position ${input.position}` : "",
    ]
      .filter((x) => x !== "")
      .join(" ");
    return {
      ok: false,
      message: `the module has no placement at ${asked}. Its placements: ${list}. Set blockName + position to one of them.`,
    };
  }
  if (input.allPlacements === true || addressed.length === 1) {
    return { ok: true, picked: addressed };
  }
  const scope = input.blockName !== undefined ? ` in block "${input.blockName}"` : "";
  return {
    ok: false,
    message: `the module is placed ${addressed.length} times${scope}: ${addressed.map(describe).join("; ")}. Pass blockName + position for the one to remove (the others keep their content), or allPlacements:true only when the operator asked to remove every one.`,
  };
}

/** Longest text of one content value a refusal shows. */
const PREVIEW_VALUE_CHARS = 40;
/** Content values a refusal shows per placement. */
const PREVIEW_VALUES = 3;

/**
 * A short look at what one placement shows (`hero_title="Book a call", …`),
 * so the AI can tell two placements of one module apart by their content.
 */
export function contentPreview(values: Readonly<Record<string, unknown>> | undefined): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(values ?? {})) {
    if (parts.length >= PREVIEW_VALUES) break;
    let shown: string | null = null;
    if (typeof value === "string") {
      const text = value
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (text === "") continue;
      shown = JSON.stringify(
        text.length > PREVIEW_VALUE_CHARS ? `${text.slice(0, PREVIEW_VALUE_CHARS)}…` : text,
      );
    } else if (typeof value === "number" || typeof value === "boolean") {
      shown = String(value);
    } else if (Array.isArray(value)) {
      shown = `[${value.length} item${value.length === 1 ? "" : "s"}]`;
    }
    if (shown !== null) parts.push(`${key}=${shown}`);
  }
  return parts.length > 0 ? parts.join(", ") : "no content yet";
}

export const removeModuleFromTool: ToolDefinitionWithHandler<RemoveModuleFromToolInput> = {
  name: "remove_module_from",
  description:
    'Remove a module placement from a page or layout; the module itself stays for reuse. `target:"page"` = this page only; `target:"layout"` = site-wide chrome (\'remove the footer from every page\'). Module placed twice+ on the target -> name the one via `blockName` + `position`; the others keep their content. To replace a module, PREFER `update_modules_many` (keeps the slot) over remove + add.',
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
      blockName: {
        type: "string",
        minLength: 1,
        maxLength: 80,
        description:
          "With `position`: which placement, when the module is on the target twice+ (page: BEGIN markers / `inspect_page_render`; layout: `list_layouts` order).",
      },
      position: {
        type: "integer",
        minimum: 0,
        maximum: 1000,
        description: "0-based index in `blockName`.",
      },
      allPlacements: {
        type: "boolean",
        description:
          "Remove every placement (in `blockName` when given). Only when the operator asks for all of them.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    return input.target === "page"
      ? removeFromPage(ctx, toolCtx, input)
      : removeFromLayout(ctx, toolCtx, input);
  },
};

/** A page placement of the module, with the content it is bound to. */
interface PagePlacement extends PlacementAt {
  readonly contentInstanceId: string | null;
}

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
  const found: PagePlacement[] = page.blocks.flatMap((b) =>
    b.modules.flatMap((m, position) =>
      m.moduleId === input.moduleId
        ? [{ blockName: b.blockName, position, contentInstanceId: m.contentInstanceId ?? null }]
        : [],
    ),
  );
  if (found.length === 0) {
    return {
      ok: false,
      content: `module ${input.moduleId} is not placed on page ${pageId} — inspect_page_render lists the page's modules (block + position).`,
      refusal: true,
    };
  }
  let pick = pickPlacements(found, input, at);
  if (!pick.ok) {
    // Only a refusal pays for the content read: the preview is what lets
    // the AI pick the placement the operator means.
    const previews = await contentPreviews(ctx, toolCtx, found);
    pick = pickPlacements(found, input, (p) => {
      const ci = p.contentInstanceId;
      if (ci === null || !previews.ok) return at(p);
      return `${at(p)} (content ${ci}: ${previews.byId.get(ci) ?? "instance not found"})`;
    });
    if (!pick.ok) {
      return {
        ok: false,
        content:
          `page ${pageId}: ${pick.message}` +
          (previews.ok ? "" : ` (content previews unavailable: ${previews.message})`),
        refusal: true,
      };
    }
  }
  const removed = new Set(pick.picked.map((p) => `${p.blockName}#${p.position}`));
  // Every survivor is named by its content instance and sync mode, so each
  // keeps its own content and mode — set_modules' per-(block, module) FIFO
  // would hand the removed placement's content to a later placement of the
  // same module, and an instance shared across blocks its mode.
  const blocks = page.blocks.map((b) => {
    const kept = b.modules.filter((_, i) => !removed.has(`${b.blockName}#${i}`));
    return {
      blockName: b.blockName,
      moduleIds: kept.map((m) => m.moduleId),
      contentInstanceIds: kept.map((m) => m.contentInstanceId ?? null),
      syncModes: kept.map((m) => (m.contentInstanceId ? m.syncMode : null)),
    };
  });
  const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.set_modules", {
    pageId,
    blocks,
  });
  if (!r.ok) return toolError(r.error, `pages.set_modules failed: ${describeError(r.error)}`);
  const left = blocks.flatMap((b) =>
    b.moduleIds.flatMap((id, position) =>
      id === input.moduleId ? [at({ blockName: b.blockName, position })] : [],
    ),
  );
  return {
    ok: true,
    content:
      `module ${input.moduleId} removed from page ${pageId} at ${pick.picked.map(at).join(", ")}` +
      (left.length > 0
        ? `; its other placement(s), content unchanged, now at ${left.join(", ")}.`
        : "."),
  };
}

/** Content preview per content instance id (as this chat's draft has it). */
async function contentPreviews(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  placements: readonly PagePlacement[],
): Promise<
  | { readonly ok: true; readonly byId: Map<string, string> }
  | { readonly ok: false; readonly message: string }
> {
  const ids = [
    ...new Set(placements.flatMap((p) => (p.contentInstanceId ? [p.contentInstanceId] : []))),
  ];
  const byId = new Map<string, string>();
  if (ids.length === 0) return { ok: true, byId };
  const listed = await execute(toolCtx.registry, toolCtx.adapter, ctx, "content_instances.list", {
    ids,
  });
  if (!listed.ok) {
    return { ok: false, message: `content_instances.list failed: ${describeError(listed.error)}` };
  }
  for (const i of (listed.value as { instances: { id: string; values: Record<string, unknown> }[] })
    .instances) {
    byId.set(i.id, contentPreview(i.values));
  }
  return { ok: true, byId };
}

async function removeFromLayout(
  ctx: ExecutionContext,
  toolCtx: ToolContext,
  input: RemoveModuleFromToolInput,
): Promise<ToolResult> {
  const got = await execute(
    toolCtx.registry,
    toolCtx.adapter,
    ctx,
    "layouts.get",
    UUID_RE.test(input.targetRef) ? { layoutId: input.targetRef } : { slug: input.targetRef },
  );
  if (!got.ok) return toolError(got.error, `layouts.get failed: ${describeError(got.error)}`);
  const layout = (got.value as { layout: LayoutDetail | null }).layout;
  if (!layout) return refNotFound("layout", input.targetRef);
  const blockIds = new Map<string, string[]>();
  for (const block of layout.blocks) {
    const existing = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layout_modules.get", {
      layoutId: layout.id,
      blockName: block.name,
    });
    if (!existing.ok) {
      return toolError(
        existing.error,
        `layout_modules.get failed for block "${block.name}": ${describeError(existing.error)}`,
      );
    }
    blockIds.set(block.name, (existing.value as { moduleIds: string[] }).moduleIds);
  }
  const found: PlacementAt[] = [...blockIds].flatMap(([blockName, ids]) =>
    ids.flatMap((id, position) => (id === input.moduleId ? [{ blockName, position }] : [])),
  );
  if (found.length === 0) {
    return {
      ok: false,
      content: `module ${input.moduleId} not attached to any block on layout "${layout.slug}" — list_layouts shows each block's chrome modules.`,
      refusal: true,
    };
  }
  const pick = pickPlacements(found, input, at);
  if (!pick.ok) {
    return { ok: false, content: `layout "${layout.slug}": ${pick.message}`, refusal: true };
  }
  const done: string[] = [];
  for (const [blockName, ids] of blockIds) {
    const drop = new Set(
      pick.picked.filter((p) => p.blockName === blockName).map((p) => p.position),
    );
    if (drop.size === 0) continue;
    const setRes = await execute(toolCtx.registry, toolCtx.adapter, ctx, "layout_modules.set", {
      layoutId: layout.id,
      blockName,
      moduleIds: ids.filter((_, i) => !drop.has(i)),
    });
    if (!setRes.ok) {
      return toolError(
        setRes.error,
        `layout_modules.set failed for block "${blockName}": ${describeError(setRes.error)}` +
          (done.length > 0 ? ` (already removed from block(s) ${done.join(", ")})` : ""),
      );
    }
    done.push(`"${blockName}"`);
  }
  return {
    ok: true,
    content: `module ${input.moduleId} detached from layout "${layout.slug}" at ${pick.picked.map(at).join(", ")}`,
  };
}

function refNotFound(target: string, ref: string): ToolResult {
  return {
    ok: false,
    content: `no ${target} found for targetRef "${ref}" — pass a valid slug or uuid (list_pages / list_layouts).`,
  };
}
