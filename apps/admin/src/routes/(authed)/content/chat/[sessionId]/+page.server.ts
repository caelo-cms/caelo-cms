// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo-cms/query-api";
import { error, fail } from "@sveltejs/kit";
import type { ChatMessage, ChatModule, ChatSession } from "$lib/components/chat/types.js";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface ChatPageData {
  session: ChatSession;
  messages: ChatMessage[];
  modules: ChatModule[];
  /** v0.2.46 — gates the debug panel. True when the user has
   *  settings.read; the page component then opts in via `?debug=1`. */
  canDebug: boolean;
  /**
   * v0.3.21 — default page to render in the live-preview pane. Falls
   * back to home/en, then the first page in the list, then null when
   * the install has zero pages (fresh-install case). Null collapses
   * the preview pane until the AI creates the first page.
   */
  previewDefault: { locale: string; slug: string } | null;
}

export const load: PageServerLoad = async ({ params, locals }): Promise<ChatPageData> => {
  requirePermission(locals, "content.read");
  const { adapter, registry } = getQueryContext();
  const [sessionR, modulesR, pagesR] = await Promise.all([
    execute(registry, adapter, locals.ctx, "chat.get_session", {
      chatSessionId: params.sessionId,
    }),
    execute(registry, adapter, locals.ctx, "modules.list", {}),
    execute(registry, adapter, locals.ctx, "pages.list", {}),
  ]);
  if (!sessionR.ok) throw error(404, "Chat not found");
  const sessionData = sessionR.value as {
    session: ChatSession;
    messages: (ChatMessage & {
      toolCalls: unknown;
      createdAt: string;
      thinkingBlocks: { thinking: string; signature: string }[] | null;
    })[];
  };
  const modules = modulesR.ok ? (modulesR.value as { modules: ChatModule[] }).modules : [];
  // v0.2.54 — flatten thinking blocks to text for ChatPanel rendering.
  // Signatures stay server-side; the UI only shows the model's reasoning
  // text in a collapsed details block.
  const messages = sessionData.messages.map((m) => ({
    ...m,
    thinkingText:
      Array.isArray(m.thinkingBlocks) && m.thinkingBlocks.length > 0
        ? m.thinkingBlocks.map((b) => b.thinking).join("\n\n")
        : undefined,
  }));
  // v0.3.21 — pick the default preview page (mirrors /edit's logic).
  // Prefer home/en, fall back to the first page, null when none exist.
  const allPages = pagesR.ok
    ? (pagesR.value as { pages: { slug: string; locale: string }[] }).pages
    : [];
  const home = allPages.find((p) => p.slug === "home" && p.locale === "en");
  const firstPage = allPages[0];
  const previewDefault = home
    ? { locale: home.locale, slug: home.slug }
    : firstPage
      ? { locale: firstPage.locale, slug: firstPage.slug }
      : null;

  return {
    session: sessionData.session,
    messages,
    modules,
    // v0.2.46 — debug panel exposes engaged-skills + tool args, so it
    // needs the same permission as the rest of /security/* views.
    canDebug: locals.user?.permissions.has("settings.read") ?? false,
    previewDefault,
  };
};

export const actions: Actions = {
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
  // v0.2.54 — toggle extended thinking on/off for this chat session.
  // The form posts a single `enabled` checkbox; budget tuning is left
  // to a future setting surface (default 10000 covers every realistic
  // turn). Per-chat preference takes effect on the NEXT user send.
  set_extended_thinking: async ({ params, request, locals }) => {
    requirePermission(locals, "content.read");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const enabled = form.get("enabled") === "1";
    const result = await execute(registry, adapter, locals.ctx, "chat.set_extended_thinking", {
      chatSessionId: params.sessionId,
      enabled,
    });
    if (!result.ok) return fail(400, { error: "Could not toggle extended thinking." });
    return { ok: true, extendedThinkingEnabled: enabled };
  },
};
