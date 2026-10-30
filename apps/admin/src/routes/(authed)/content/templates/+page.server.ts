// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const { adapter, registry } = getQueryContext();
  const [result, typesResult] = await Promise.all([
    execute(registry, adapter, locals.ctx, "templates.list", {}),
    execute(registry, adapter, locals.ctx, "page_types.list", {}),
  ]);
  // #1276 — every template serves a page type: an existing one, or a new
  // one created with it.
  const pageTypes = typesResult.ok
    ? (typesResult.value as { pageTypes: { slug: string; name: string }[] }).pageTypes
    : [];
  const templates = result.ok
    ? (
        result.value as {
          templates: { id: string; slug: string; displayName: string; updatedAt: string }[];
        }
      ).templates
    : [];
  return { templates, pageTypes };
};

/** Form value of the page type select that asks for a new type. */
const NEW_PAGE_TYPE = "__new__";

export const actions: Actions = {
  create: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const slug = String(form.get("slug") ?? "").trim();
    const displayName = String(form.get("displayName") ?? "").trim();
    const html = String(form.get("html") ?? "");
    const pageType = String(form.get("pageType") ?? "");
    if (!pageType) {
      return fail(400, { error: "Choose the page type this template serves, or a new one." });
    }
    const newCollection = String(form.get("newPageTypeCollection") ?? "");
    if (pageType === NEW_PAGE_TYPE && newCollection !== "true" && newCollection !== "false") {
      return fail(400, {
        error: "Say whether the new type's pages are many similar pages or standalone pages.",
      });
    }
    const typeInput =
      pageType === NEW_PAGE_TYPE
        ? {
            newPageType: {
              slug: String(form.get("newPageTypeSlug") ?? "").trim(),
              name: String(form.get("newPageTypeName") ?? "").trim(),
              purpose: String(form.get("newPageTypePurpose") ?? "").trim(),
              collection: form.get("newPageTypeCollection") === "true",
            },
          }
        : { pageType };

    const result = await execute(registry, adapter, locals.ctx, "templates.create", {
      slug,
      displayName,
      html,
      ...typeInput,
    });
    if (!result.ok) {
      const message = (result.error as { message?: string }).message;
      return fail(400, {
        error: message ? `Could not create template: ${message}` : "Could not create template.",
      });
    }
    const templateId = (result.value as { templateId: string }).templateId;
    throw redirect(303, `/content/templates/${templateId}`);
  },
};
