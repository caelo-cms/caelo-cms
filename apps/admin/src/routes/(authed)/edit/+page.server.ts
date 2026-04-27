// SPDX-License-Identifier: MPL-2.0

import { execute } from "@caelo/query-api";
import { fail, redirect } from "@sveltejs/kit";
import type { ChatMessage, ChatModule, ChatSession } from "$lib/components/chat/types.js";
import {
  DEFAULT_LAYOUT,
  type OverlayLayout,
} from "$lib/components/edit/use-overlay-layout.svelte.js";
import { assertCsrfToken } from "$lib/server/csrf.js";
import { requirePermission } from "$lib/server/guards.js";
import { getQueryContext } from "$lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

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

  // P6.7.2 — drop the `published` filter. The live-edit surface always
  // renders the latest editable composition (chat-branch-aware via
  // pages.render_preview); whether a page is `draft` or `published` is
  // irrelevant for previewing inside /edit. The published static site
  // is what Caddy serves on :8082 — not what /edit shows.
  const pages = pagesR.ok ? (pagesR.value as { pages: PageRow[] }).pages : [];
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
  // prefer the seeded `home` slug; otherwise the first page in the list.
  const queryPage = url.searchParams.get("page");
  const home = pages.find((p) => p.slug === "home" && p.locale === "en");
  const activePage = pages.find((p) => p.id === queryPage) ?? home ?? pages[0] ?? null;
  const activePageId = activePage?.id ?? null;

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

/**
 * Stage / Confirm publish actions live on the /edit route itself so
 * submitting the overlay's publish strip keeps the user on /edit. Same
 * op chain as /content/pages?/stage and ?/confirmPublish — copied not
 * imported because SvelteKit's actions can't be re-exported across
 * routes (the wrapper would have to recreate the form-data parsing).
 */
export const actions: Actions = {
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
    if (!stagingDeploy.ok) return fail(500, { error: "Staging build failed." });

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
        previewUrl: stagingBaseUrl,
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
    if (!promote.ok) return fail(500, { error: "Promotion to production failed." });
    return {
      published: {
        pageId,
        targetName: "production",
      },
    };
  },
};
