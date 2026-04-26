// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, locals.ctx, "chat.list_sessions", {});
  const sessions = r.ok
    ? (
        r.value as {
          sessions: {
            id: string;
            title: string;
            lastActiveAt: string;
            publishedAt: string | null;
          }[];
        }
      ).sessions
    : [];
  return { sessions };
};

export const actions: Actions = {
  create: async ({ request, locals }) => {
    requirePermission(locals, "content.read");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const result = await execute(registry, adapter, locals.ctx, "chat.create_session", {});
    if (!result.ok) return fail(400, { error: "Could not create chat." });
    const id = (result.value as { chatSessionId: string }).chatSessionId;
    throw redirect(303, `/content/chat/${id}`);
  },
};
