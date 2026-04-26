// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  const { adapter, registry } = getQueryContext();
  const [pagesResult, templatesResult] = await Promise.all([
    execute(registry, adapter, locals.ctx, "pages.list", {}),
    execute(registry, adapter, locals.ctx, "templates.list", {}),
  ]);
  const pages = pagesResult.ok
    ? (
        pagesResult.value as {
          pages: {
            id: string;
            slug: string;
            locale: string;
            title: string;
            status: string;
            updatedAt: string;
          }[];
        }
      ).pages
    : [];
  const templates = templatesResult.ok
    ? (
        templatesResult.value as {
          templates: { id: string; slug: string; displayName: string }[];
        }
      ).templates
    : [];
  return { pages, templates };
};

export const actions: Actions = {
  create: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const slug = String(form.get("slug") ?? "").trim();
    const title = String(form.get("title") ?? "").trim();
    const templateId = String(form.get("templateId") ?? "");
    const locale = String(form.get("locale") ?? "en");

    const result = await execute(registry, adapter, locals.ctx, "pages.create", {
      slug,
      title,
      templateId,
      locale,
    });
    if (!result.ok) return fail(400, { error: "Could not create page." });
    const pageId = (result.value as { pageId: string }).pageId;
    throw redirect(303, `/content/pages/${pageId}`);
  },
  publish: async ({ request, locals }) => {
    requirePermission(locals, "deploy.trigger");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const pageId = String(form.get("pageId") ?? "");
    const updateResult = await execute(registry, adapter, locals.ctx, "pages.update", {
      pageId,
      status: "published",
    });
    if (!updateResult.ok) return fail(400, { error: "Could not publish page." });

    // Editor view: one click maps to "deploy to default target".
    // Ops users see the dev/staging/production model at /security/deployments.
    const deployResult = await execute(registry, adapter, locals.ctx, "deploy.trigger", {});
    if (!deployResult.ok) {
      return fail(500, { error: "Page marked published but deploy failed." });
    }
    const summary = deployResult.value as {
      targetName: string;
      pageCount: number;
      fileCount: number;
    };
    return {
      published: {
        pageId,
        targetName: summary.targetName,
        pageCount: summary.pageCount,
        fileCount: summary.fileCount,
      },
    };
  },
};
