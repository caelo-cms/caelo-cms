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
  // P6.2 #3 — preview → confirm publish. Editor flow is now two clicks:
  //
  //   1. "Stage" runs `pages.update {status: published}` then
  //      `deploy.trigger {staging}` and returns a staging preview URL.
  //      Production stays untouched.
  //   2. "Confirm publish" runs `deploy.promote {staging → production}`
  //      from the form returned by step 1.
  //
  // This honours CMS_REQUIREMENTS §16.5 in spirit — staging is a
  // *gate*, not a stepping stone — while keeping the editor mental
  // model simple. Editors with `ops.view` still get the explicit
  // multi-target dashboard at /security/deployments.
  stage: async ({ request, locals }) => {
    requirePermission(locals, "deploy.trigger");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);

    const pageId = String(form.get("pageId") ?? "");
    const updateResult = await execute(registry, adapter, locals.ctx, "pages.update", {
      pageId,
      status: "published",
    });
    if (!updateResult.ok) return fail(400, { error: "Could not mark page as published." });

    const stagingDeploy = await execute(registry, adapter, locals.ctx, "deploy.trigger", {
      targetName: "staging",
    });
    if (!stagingDeploy.ok) {
      return fail(500, { error: "Staging build failed." });
    }
    const summary = stagingDeploy.value as {
      pageCount: number;
      fileCount: number;
      buildId: string;
    };

    const stagingBaseUrl = process.env["CAELO_STAGING_BASE_URL"] ?? "http://localhost:8081";
    return {
      staged: {
        pageId,
        pageCount: summary.pageCount,
        fileCount: summary.fileCount,
        buildId: summary.buildId,
        previewUrl: `${stagingBaseUrl}`,
      },
    };
  },
  confirmPublish: async ({ request, locals }) => {
    requirePermission(locals, "deploy.trigger");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const pageId = String(form.get("pageId") ?? "");

    const promote = await execute(registry, adapter, locals.ctx, "deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
    });
    if (!promote.ok) {
      return fail(500, { error: "Promotion to production failed." });
    }
    return {
      published: {
        pageId,
        targetName: "production",
      },
    };
  },
};
