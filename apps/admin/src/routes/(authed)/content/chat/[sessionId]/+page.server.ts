// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { error, fail, redirect } from "@sveltejs/kit";
import type { ChatMessage, ChatModule, ChatSession } from "$lib/components/chat/types.js";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface ChatPageData {
  session: ChatSession;
  messages: ChatMessage[];
  modules: ChatModule[];
}

export const load: PageServerLoad = async ({ params, locals }): Promise<ChatPageData> => {
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
    session: ChatSession;
    messages: (ChatMessage & { toolCalls: unknown; createdAt: string })[];
  };
  const modules = modulesR.ok ? (modulesR.value as { modules: ChatModule[] }).modules : [];
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
    // P5.2 #5 — partial publish. Form sends `entity[]` as `kind:id`
    // pairs (one per ticked checkbox). Empty array → publish everything.
    const rawEntities = form.getAll("entity");
    const entities: { kind: "module" | "template" | "page" | "pageLayout"; entityId: string }[] =
      [];
    for (const e of rawEntities) {
      const [kind, id] = String(e).split(":");
      if (
        (kind === "module" || kind === "template" || kind === "page" || kind === "pageLayout") &&
        id
      ) {
        entities.push({ kind, entityId: id });
      }
    }
    const result = await execute(registry, adapter, locals.ctx, "chat.publish", {
      chatSessionId: params.sessionId,
      ...(entities.length > 0 ? { entities } : {}),
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
