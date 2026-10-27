// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { error, fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import {
  jsonField,
  loadPagePicks,
  loadPageTypes,
  loadVocabularies,
  runWrite,
  versionField,
  writeFailure,
} from "#lib/server/lists.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, locals }) => {
  const { adapter, registry } = getQueryContext();
  const [
    pageResult,
    modulesResult,
    templatesResult,
    pagesResult,
    pageTypes,
    vocabularies,
    pagePicks,
  ] = await Promise.all([
    execute(registry, adapter, locals.ctx, "pages.get_with_modules", { pageId: params.id }),
    execute(registry, adapter, locals.ctx, "modules.list", {}),
    execute(registry, adapter, locals.ctx, "templates.list", {}),
    execute(registry, adapter, locals.ctx, "pages.list", {}),
    // Epic #1107 — page type, properties and terms in the page settings.
    loadPageTypes(locals.ctx),
    loadVocabularies(locals.ctx),
    loadPagePicks(locals.ctx),
  ]);
  if (!pageResult.ok) throw error(404, "Page not found");
  return {
    pageTypes,
    vocabularies,
    pagePicks,
    page: (pageResult.value as { page: unknown }).page,
    // Epic #690 — the parent picker's candidates (the tree helpers drop
    // this page, its subtree and the homepage).
    allPages: pagesResult.ok
      ? (
          pagesResult.value as {
            pages: {
              id: string;
              title: string;
              currentPath: string;
              parentPageId: string | null;
            }[];
          }
        ).pages
      : [],
    allModules: modulesResult.ok
      ? (
          modulesResult.value as {
            modules: { id: string; slug: string; displayName: string }[];
          }
        ).modules
      : [],
    allTemplates: templatesResult.ok
      ? (
          templatesResult.value as {
            templates: {
              id: string;
              slug: string;
              displayName: string;
              blocks: { name: string; displayName: string }[];
            }[];
          }
        ).templates
      : [],
  };
};

interface BlockSubmission {
  blockName: string;
  moduleIds: string[];
}

function parseBlocks(form: FormData): BlockSubmission[] {
  // Form fields: blocks[BLOCK_NAME] = "<id>,<id>,…" (one hidden input per block)
  const out: BlockSubmission[] = [];
  for (const [key, value] of form.entries()) {
    const m = /^blocks\[(.+)\]$/.exec(key);
    if (!m?.[1]) continue;
    const moduleIds = String(value)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    out.push({ blockName: m[1], moduleIds });
  }
  return out;
}

export const actions: Actions = {
  update: async ({ params, request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const expectedVersionRaw = form.get("expectedVersion");
    const expectedVersion =
      expectedVersionRaw === null ? undefined : Number.parseInt(String(expectedVersionRaw), 10);

    const result = await execute(registry, adapter, locals.ctx, "pages.update", {
      pageId: params.id,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      title: String(form.get("title") ?? ""),
      shortTitle: String(form.get("shortTitle") ?? ""),
      status: String(form.get("status") ?? "draft") === "published" ? "published" : "draft",
    });
    if (!result.ok) {
      const message = (result.error as { message?: string }).message ?? "";
      if (message.startsWith("conflict")) {
        return fail(409, { error: `${message} — reload the page and try again.` });
      }
      return fail(400, { error: "Could not update page metadata." });
    }
    return { ok: true };
  },

  /**
   * Epic #690 — move the page under another page (or to the top level),
   * optionally renaming it in the same step. The whole subtree moves
   * with it; old URLs get 301s, and links on the site follow the page
   * because they are page references (pages.move_many, epic #724).
   */
  move: async ({ params, request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const parentPageId = String(form.get("parentPageId") ?? "");
    const newSlug = String(form.get("newSlug") ?? "").trim();
    const result = await execute(registry, adapter, locals.ctx, "pages.move_many", {
      moves: [
        {
          pageId: params.id,
          parentPageId: parentPageId === "" ? null : parentPageId,
          ...(newSlug ? { newSlug } : {}),
        },
      ],
    });
    if (!result.ok) {
      const message = (result.error as { message?: string }).message;
      return fail(400, { error: message ?? "Could not move page." });
    }
    const moved = (result.value as { moved: { from: string; to: string }[] }).moved;
    return { ok: true, movedCount: moved.length };
  },

  setModules: async ({ params, request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const expectedVersionRaw = form.get("expectedVersion");
    const expectedVersion =
      expectedVersionRaw === null ? undefined : Number.parseInt(String(expectedVersionRaw), 10);

    const blocks = parseBlocks(form);
    const result = await execute(registry, adapter, locals.ctx, "pages.set_modules", {
      pageId: params.id,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      blocks,
    });
    if (!result.ok) {
      const message = (result.error as { message?: string }).message ?? "";
      if (message.startsWith("conflict")) {
        return fail(409, { error: `${message} — reload the page and try again.` });
      }
      return fail(400, { error: "Could not save page layout." });
    }
    return { ok: true };
  },

  /**
   * Epic #1107 — page type, template, properties and terms in one
   * `pages.update`, which checks them against the (new) type.
   */
  setPageType: async ({ params, request, locals }) => {
    requirePermission(locals, "content.write");
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const properties = jsonField<Record<string, unknown>>(form, "properties");
    const terms = jsonField<string[]>(form, "terms");
    const pageType = String(form.get("pageType") ?? "");
    const templateId = String(form.get("templateId") ?? "");
    if (!properties || !terms || !pageType || !templateId) {
      return fail(400, { error: "The page type settings could not be read — reload and retry." });
    }
    const expectedVersion = versionField(form);
    const r = await runWrite(locals.ctx, "pages.update", {
      pageId: params.id,
      pageType,
      templateId,
      properties,
      terms,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
    if (!r.ok) return writeFailure(r.message);
    return { ok: "Page type saved." };
  },

  delete: async ({ params, request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const result = await execute(registry, adapter, locals.ctx, "pages.delete", {
      pageId: params.id,
    });
    if (!result.ok) {
      // e.g. "has 3 child page(s) … move them first" — the op names the fix.
      const message = (result.error as { message?: string }).message;
      return fail(400, {
        error: message ? `Could not delete page: ${message}` : "Could not delete page.",
      });
    }
    throw redirect(303, "/content/pages");
  },

  // v0.12.4 — bind a placement to a content_instance + choose sync mode.
  // Powers the PlacementSyncToggle's "share with another page" affordance.
  setPlacementContent: async ({ params, request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const blockName = String(form.get("blockName") ?? "");
    const position = Number.parseInt(String(form.get("position") ?? ""), 10);
    const contentInstanceId = String(form.get("contentInstanceId") ?? "");
    const syncMode = String(form.get("syncMode") ?? "synced");
    const result = await execute(registry, adapter, locals.ctx, "placement.set_content", {
      pageId: params.id,
      blockName,
      position,
      contentInstanceId,
      syncMode: syncMode === "unsynced" ? "unsynced" : "synced",
    });
    if (!result.ok) {
      const message = (result.error as { message?: string }).message ?? "could not bind placement";
      return fail(400, { error: message });
    }
    return { ok: true };
  },

  // v0.12.4 — detach a placement into a fresh unsynced content_instance.
  // Powers the PlacementSyncToggle's "edit only this page" affordance.
  forkPlacementContent: async ({ params, request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const blockName = String(form.get("blockName") ?? "");
    const position = Number.parseInt(String(form.get("position") ?? ""), 10);
    const result = await execute(registry, adapter, locals.ctx, "placement.fork_content", {
      pageId: params.id,
      blockName,
      position,
    });
    if (!result.ok) {
      const message = (result.error as { message?: string }).message ?? "could not fork placement";
      return fail(400, { error: message });
    }
    return { ok: true };
  },
};
