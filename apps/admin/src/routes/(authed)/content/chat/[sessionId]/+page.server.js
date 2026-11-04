// SPDX-License-Identifier: MPL-2.0
import { execute } from "@caelo-cms/query-api";
import { error, fail } from "@sveltejs/kit";
import { loadTranscriptPage } from "#lib/server/chat-transcript.js";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
export const load = async ({ params, locals }) => {
    requirePermission(locals, "content.read");
    const { adapter, registry } = getQueryContext();
    // #1216 — the newest transcript page; older pages load on demand.
    const [transcript, modulesR, pagesR] = await Promise.all([
        loadTranscriptPage(locals.ctx, params.sessionId),
        execute(registry, adapter, locals.ctx, "modules.list", {}),
        execute(registry, adapter, locals.ctx, "pages.list", {}),
    ]);
    if (!transcript)
        throw error(404, "Chat not found");
    const modules = modulesR.ok ? modulesR.value.modules : [];
    // v0.3.21 — pick the default preview page (mirrors /edit's logic).
    // Prefer the composed root, fall back to the first page, null when
    // none exist.
    const allPages = pagesR.ok ? pagesR.value.pages : [];
    const home = allPages.find((p) => p.currentPath === "/");
    const firstPage = allPages[0];
    const previewDefault = home
        ? { path: home.currentPath }
        : firstPage
            ? { path: firstPage.currentPath }
            : null;
    return {
        session: transcript.session,
        messages: transcript.messages,
        hasMoreMessages: transcript.hasMore,
        modules,
        // v0.2.46 — debug panel exposes engaged-skills + tool args, so it
        // needs the same permission as the rest of /settings/* views.
        canDebug: locals.user?.permissions.has("settings.read") ?? false,
        previewDefault,
    };
};
export const actions = {
    rename: async ({ params, request, locals }) => {
        requirePermission(locals, "content.write");
        const { adapter, registry } = getQueryContext();
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const title = String(form.get("title") ?? "");
        const result = await execute(registry, adapter, locals.ctx, "chat.rename_session", {
            chatSessionId: params.sessionId,
            title,
        });
        if (!result.ok)
            return fail(400, { error: "Could not rename chat." });
        return { ok: true };
    },
    // v0.2.54 — toggle extended thinking on/off for this chat session.
    // The form posts a single `enabled` checkbox; budget tuning is left
    // to a future setting surface (default 10000 covers every realistic
    // turn). Per-chat preference takes effect on the NEXT user send.
    set_extended_thinking: async ({ params, request, locals }) => {
        requirePermission(locals, "content.write");
        const { adapter, registry } = getQueryContext();
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const enabled = form.get("enabled") === "1";
        const result = await execute(registry, adapter, locals.ctx, "chat.set_extended_thinking", {
            chatSessionId: params.sessionId,
            enabled,
        });
        if (!result.ok)
            return fail(400, { error: "Could not toggle extended thinking." });
        return { ok: true, extendedThinkingEnabled: enabled };
    },
};
