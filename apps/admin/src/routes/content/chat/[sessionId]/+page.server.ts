// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { error, fail, redirect } from "@sveltejs/kit";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, locals }) => {
  requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  const [sessionR, modulesR] = await Promise.all([
    execute(registry, adapter, locals.ctx, "chat.get_session", {
      chatSessionId: params.sessionId,
    }),
    execute(registry, adapter, locals.ctx, "modules.list", {}),
  ]);
  if (!sessionR.ok) throw error(404, "Chat not found");
  const sessionData = sessionR.value as {
    session: { id: string; title: string; chatBranchId: string; publishedAt: string | null };
    messages: {
      id: string;
      role: "user" | "assistant" | "tool";
      content: string;
      toolCalls: unknown;
      createdAt: string;
    }[];
  };
  const modules = modulesR.ok
    ? (
        modulesR.value as {
          modules: { id: string; slug: string; displayName: string; html: string }[];
        }
      ).modules
    : [];
  return {
    session: sessionData.session,
    messages: sessionData.messages,
    modules,
  };
};

export const actions: Actions = {
  publish: async ({ params, request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const result = await execute(registry, adapter, locals.ctx, "chat.publish", {
      chatSessionId: params.sessionId,
    });
    if (!result.ok) return fail(400, { error: "Could not publish chat." });
    throw redirect(303, `/content/chat/${params.sessionId}`);
  },
  rename: async ({ params, request, locals }) => {
    requirePermission(locals, "content.read");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const title = String(form.get("title") ?? "");
    const result = await execute(registry, adapter, locals.ctx, "chat.rename_session", {
      chatSessionId: params.sessionId,
      title,
    });
    if (!result.ok) return fail(400, { error: "Could not rename chat." });
    return { ok: true };
  },
};
