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

  // Load pages + the user's overlay layout in parallel. We can't load
  // chat sessions yet because the filter depends on the active page.
  const [pagesR, prefsR] = await Promise.all([
    execute(registry, adapter, locals.ctx, "pages.list", {}),
    execute(registry, adapter, locals.ctx, "user_preferences.get", {
      key: "edit_overlay_layout",
    }),
  ]);

  // P6.7.2 — drop the `published` filter. The live-edit surface always
  // renders the latest editable composition; whether a page is `draft`
  // or `published` is irrelevant for previewing inside /edit.
  const pages = pagesR.ok ? (pagesR.value as { pages: PageRow[] }).pages : [];

  // Pick the page to render in the iframe. URL param wins; otherwise
  // prefer the seeded `home` slug; otherwise the first page in the list.
  const queryPage = url.searchParams.get("page");
  const home = pages.find((p) => p.slug === "home" && p.locale === "en");
  const activePage = pages.find((p) => p.id === queryPage) ?? home ?? pages[0] ?? null;
  const activePageId = activePage?.id ?? null;

  // P6.7.4 — chats are now scoped to the active page. Load the page's
  // bound chats + pick the most-recent unpublished one; if none, create
  // a fresh page-bound session. Cross-page chats remain accessible from
  // /content/chat — they don't show up in this dropdown.
  const sessionsR = await execute(registry, adapter, locals.ctx, "chat.list_sessions", {
    includeArchived: false,
    pageId: activePageId,
  });
  const sessions = sessionsR.ok ? (sessionsR.value as { sessions: ChatSession[] }).sessions : [];

  const queryChat = url.searchParams.get("chat");
  let activeChat: ChatSession | null =
    sessions.find((s) => s.id === queryChat) ?? sessions.find((s) => !s.publishedAt) ?? null;
  if (!activeChat) {
    const created = await execute(registry, adapter, locals.ctx, "chat.create_session", {
      title: activePage ? `Live edit · ${activePage.slug}` : "Live edit",
      ...(activePageId ? { pageId: activePageId } : {}),
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

  // P6.6 polish — module ids the AI has touched on this chat's branch.
  // Drives the DiffPanel checkbox list so the user only sees rows
  // that actually have a pending edit; the previous fallback rendered
  // every module on the page.
  let branchEditedModuleIds: string[] = [];
  if (activeChat) {
    const editedR = await execute(registry, adapter, locals.ctx, "chat.branch_edited_modules", {
      chatSessionId: activeChat.id,
    });
    if (editedR.ok) {
      branchEditedModuleIds = (editedR.value as { moduleIds: string[] }).moduleIds;
    }
  }

  // Layout preference — default if unset.
  let layout: OverlayLayout = DEFAULT_LAYOUT;
  if (prefsR.ok) {
    const v = (prefsR.value as { value: unknown }).value;
    if (v && typeof v === "object") {
      layout = { ...DEFAULT_LAYOUT, ...(v as Partial<OverlayLayout>) };
    }
  }

  // P10 — translation banner when the active page is a non-source
  // variant. Shows status + a one-click "Bring up to date" Mode 2
  // dispatch when status === 'needs_update'.
  let translationBanner: {
    pageId: string;
    sourcePageId: string;
    targetLocale: string;
    status: "up_to_date" | "needs_update" | "not_started" | null;
  } | null = null;
  if (activePage && activePageId) {
    const fullR = await execute(registry, adapter, locals.ctx, "pages.get", {
      pageId: activePageId,
    });
    if (fullR.ok) {
      const p = (
        fullR.value as { page: { translationStatus: string; locale: string; slug: string } | null }
      ).page;
      if (p && p.translationStatus !== "source") {
        // Find the source page row by slug + the default locale (the
        // matrix's `sourcePageId` is reusable here, but a single
        // pages.list lookup is cheaper than re-running the matrix).
        const sourceR = await execute(registry, adapter, locals.ctx, "pages.list", {
          slug: p.slug,
        });
        if (sourceR.ok) {
          const list = (
            sourceR.value as { pages: { id: string; locale: string; translationStatus: string }[] }
          ).pages;
          const src = list.find((r) => r.translationStatus === "source");
          if (src) {
            translationBanner = {
              pageId: activePageId,
              sourcePageId: src.id,
              targetLocale: p.locale,
              status: p.translationStatus as "up_to_date" | "needs_update" | "not_started",
            };
          }
        }
      }
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
    branchEditedModuleIds,
    layout,
    translationBanner,
    /** P6.7.4 — chats bound to the active page (for the history dropdown). */
    pageChats: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      lastActiveAt: s.lastActiveAt,
      publishedAt: s.publishedAt,
    })),
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
  /**
   * P6.7.4 — "+ New chat" creates a fresh page-bound session and
   * redirects with `?chat=<id>` so the loader picks it up. Page id is
   * carried in the form so we don't have to re-derive activePage.
   */
  newChat: async ({ request, locals, url }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const pageId = String(form.get("pageId") ?? "");
    const created = await execute(registry, adapter, locals.ctx, "chat.create_session", {
      title: "New chat",
      ...(pageId.length > 0 ? { pageId } : {}),
    });
    if (!created.ok) return fail(500, { error: "Could not create chat." });
    const newId = (created.value as { chatSessionId: string }).chatSessionId;
    const next = new URL(url);
    next.searchParams.set("chat", newId);
    if (pageId.length > 0) next.searchParams.set("page", pageId);
    throw redirect(303, `${next.pathname}${next.search}`);
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
