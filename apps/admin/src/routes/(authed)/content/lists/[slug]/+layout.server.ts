// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — one shared list: the list, its type (with how many lists
 * share it) and the editor's tabs (`#lib/lists/editor-tabs.ts`, the
 * extension point for plugin tabs). Every tab reads this.
 */

import { error } from "@sveltejs/kit";
import { listEditorTabs } from "#lib/lists/editor-tabs.js";
import { requirePermission } from "#lib/server/guards.js";
import { loadActivePluginSlugs, loadList, loadListType } from "#lib/server/lists.js";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ params, locals }) => {
  const user = requirePermission(locals, "content.read");
  const list = await loadList(locals.ctx, { slug: params.slug });
  if (!list) throw error(404, `No list "${params.slug}".`);
  const [type, activePlugins] = await Promise.all([
    loadListType(locals.ctx, list.type),
    loadActivePluginSlugs(locals.ctx),
  ]);
  if (!type) {
    throw error(
      500,
      `The list "${list.slug}" names the type "${list.type}", which does not exist. Restore the type under Menus & lists → Types.`,
    );
  }
  return {
    list,
    listType: type.listType,
    typeLists: type.lists,
    typeLocalLists: type.localLists,
    tabs: listEditorTabs(list.slug, new Set(activePlugins)),
    canWrite: user.permissions.has("content.write"),
    canStructure: user.permissions.has("content.structure"),
  };
};
