// SPDX-License-Identifier: MPL-2.0

/**
 * Read one content row's bodies for `read_content` / `edit_content`, with a
 * not-found answer the AI can act on.
 *
 * Module, template and layout ids look alike, and list results print several
 * of them side by side (`list_templates` shows each template's `layoutId`).
 * An id passed under the wrong `entityKind` used to come back as the bare
 * "templates.get failed: template not found" (e2e-livedit 2026-10, a layout
 * id read as a template), which leaves the AI guessing. When the id is a row
 * of another kind, the answer names that kind.
 */

import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { describeError } from "../tools/_describe-error.js";
import type { ToolContext } from "../tools/dispatch.js";
import { CONTENT_ENTITY_KINDS, CONTENT_TARGETS, type ContentTarget } from "./registry.js";

/** The bodies of one row, or the tool-result text explaining why there are none. */
export type ContentRowRead =
  | { readonly ok: true; readonly bodies: Record<string, string> }
  | { readonly ok: false; readonly content: string };

/** The get op's raw outcome: the row's bodies, null for "no such row", or the error. */
async function fetchBodies(
  ctx: ExecutionContext,
  toolCtx: Pick<ToolContext, "registry" | "adapter">,
  target: ContentTarget,
  entityId: string,
): Promise<{ bodies: Record<string, string> | null } | { error: unknown }> {
  const res = await execute(toolCtx.registry, toolCtx.adapter, ctx, target.getOp, {
    [target.idArg]: entityId,
  });
  if (res.ok) return { bodies: target.readRow(res.value) };
  return isNotFound(res.error) ? { bodies: null } : { error: res.error };
}

function isNotFound(error: unknown): boolean {
  return /not found/i.test(describeError(error));
}

/**
 * Read `entityId`'s bodies through `target`'s get op.
 *
 * @returns the bodies, or a failure whose `content` says which kind the id
 *   really is when it belongs to another content kind.
 */
export async function readContentRow(
  ctx: ExecutionContext,
  toolCtx: Pick<ToolContext, "registry" | "adapter">,
  target: ContentTarget,
  entityId: string,
): Promise<ContentRowRead> {
  const got = await fetchBodies(ctx, toolCtx, target, entityId);
  if ("error" in got) {
    return { ok: false, content: `${target.getOp} failed: ${describeError(got.error)}` };
  }
  if (got.bodies !== null) return { ok: true, bodies: got.bodies };

  for (const kind of CONTENT_ENTITY_KINDS) {
    if (kind === target.entityKind) continue;
    const other = await fetchBodies(ctx, toolCtx, CONTENT_TARGETS[kind], entityId);
    if ("bodies" in other && other.bodies !== null) {
      return {
        ok: false,
        content: `${entityId} is a ${kind}, not a ${target.entityKind} — call again with entityKind:"${kind}".`,
      };
    }
  }
  // A page id is the other id the AI holds most often (Stage readiness and
  // list_pages print them), but a page has no source body of its own: it is
  // composed from modules (e2e-livedit 2026-10-25, a pageId read as a module
  // to write its meta description).
  const page = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.get", {
    pageId: entityId,
  });
  if (page.ok) {
    return {
      ok: false,
      content:
        `${entityId} is a page, not a ${target.entityKind} — pages have no source body to read here. ` +
        `Read its text (with its SEO fields) with get_page_seo({pageIds:["${entityId}"]}), how it looks with screenshot_page / inspect_page_render; ` +
        "read_content reads the html/css/js of a module, template or layout.",
    };
  }
  return {
    ok: false,
    content:
      `no ${target.entityKind} with id ${entityId} (nor a ${CONTENT_ENTITY_KINDS.filter((k) => k !== target.entityKind).join(" or ")} or page with it). ` +
      "Take the id from list_modules / list_templates / list_layouts.",
  };
}
