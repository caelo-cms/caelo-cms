// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { redirect } from "@sveltejs/kit";
import type { ChatMessage, ChatModule, ChatSession } from "$lib/components/chat/types.js";
import {
  DEFAULT_LAYOUT,
  type OverlayLayout,
} from "$lib/components/edit/use-overlay-layout.svelte.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { PageServerLoad } from "./$types";

interface PageRow {
  id: string;
  slug: string;
  locale: string;
  title: string;
  status: "draft" | "published";
}

export const load: PageServerLoad = async ({ locals, url }) => {
  requirePermission(locals, "content.write");
  const { adapter, registry } = getQueryContext();

  const [pagesR, sessionsR, prefsR] = await Promise.all([
    execute(registry, adapter, locals.ctx, "pages.list", {}),
    execute(registry, adapter, locals.ctx, "chat.list_sessions", {
      includeArchived: false,
    }),
    execute(registry, adapter, locals.ctx, "user_preferences.get", {
      key: "edit_overlay_layout",
    }),
  ]);

  const pages = pagesR.ok
    ? (pagesR.value as { pages: PageRow[] }).pages.filter((p) => p.status === "published")
    : [];
  const sessions = sessionsR.ok ? (sessionsR.value as { sessions: ChatSession[] }).sessions : [];

  // Pick or create the active chat session. URL param wins; otherwise
  // the most-recent unpublished session; otherwise create a fresh one.
  const queryChat = url.searchParams.get("chat");
  let activeChat: ChatSession | null =
    sessions.find((s) => s.id === queryChat) ?? sessions.find((s) => !s.publishedAt) ?? null;
  if (!activeChat) {
    const created = await execute(registry, adapter, locals.ctx, "chat.create_session", {
      title: "Live edit",
    });
    if (created.ok) {
      const id = (created.value as { chatSessionId: string; chatBranchId: string }).chatSessionId;
      const fresh = await execute(registry, adapter, locals.ctx, "chat.get_session", {
        chatSessionId: id,
      });
      if (fresh.ok) {
        activeChat = (fresh.value as { session: ChatSession }).session;
      }
    }
  }
  if (!activeChat) throw redirect(303, "/content/chat");

  // Pick the page to render in the iframe. URL param wins; otherwise
  // the first published page.
  const queryPage = url.searchParams.get("page");
  const activePageId = pages.find((p) => p.id === queryPage)?.id ?? pages[0]?.id ?? null;

  // Load the chat's messages + the modules list (powers the chip picker
  // inside the embedded ChatPanel).
  let messages: ChatMessage[] = [];
  if (activeChat) {
    const sR = await execute(registry, adapter, locals.ctx, "chat.get_session", {
      chatSessionId: activeChat.id,
    });
    if (sR.ok) {
      messages = (sR.value as { messages: ChatMessage[] }).messages;
    }
  }
  const modulesR = await execute(registry, adapter, locals.ctx, "modules.list", {});
  const modules = modulesR.ok ? (modulesR.value as { modules: ChatModule[] }).modules : [];

  // Layout preference — default if unset.
  let layout: OverlayLayout = DEFAULT_LAYOUT;
  if (prefsR.ok) {
    const v = (prefsR.value as { value: unknown }).value;
    if (v && typeof v === "object") {
      layout = { ...DEFAULT_LAYOUT, ...(v as Partial<OverlayLayout>) };
    }
  }

  return {
    pages: pages.map((p) => ({
      id: p.id,
      slug: p.slug,
      locale: p.locale,
      title: p.title,
    })),
    activePageId,
    activeChat,
    messages,
    modules,
    layout,
  };
};
