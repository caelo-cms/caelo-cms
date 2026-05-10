// SPDX-License-Identifier: MPL-2.0

import { describeError } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { error, fail, redirect } from "@sveltejs/kit";
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

  // P6.7.4 / v0.2.14 — chats are scoped two ways:
  //   - page-bound (`pageId = <activePageId>`): "this page's chats",
  //     auto-resume on revisit, used for content edits scoped to one
  //     page.
  //   - global (`pageId IS NULL`): cross-cutting work like layout /
  //     menu / footer changes that aren't tied to one page.
  // Both buckets are loaded in parallel and surfaced in the overlay's
  // chat picker. Form action `?/newChat` accepts an empty `pageId` to
  // create a global chat.
  const [sessionsR, globalSessionsR] = await Promise.all([
    execute(registry, adapter, locals.ctx, "chat.list_sessions", {
      includeArchived: false,
      pageId: activePageId,
    }),
    execute(registry, adapter, locals.ctx, "chat.list_sessions", {
      includeArchived: false,
      pageId: null,
    }),
  ]);
  // v0.2.56 — log the actual failure reason when an op returns ok:false.
  // Pre-v0.2.56 these were silently swallowed (`?? []`), the
  // downstream auto-create masked the symptom, and /edit eventually
  // redirected to /content/chat with no breadcrumb naming WHICH op
  // failed. Operators saw "Live edit takes me to chat" with no path
  // to diagnose. The console.error surfaces in Cloud Run stderr.
  if (!sessionsR.ok) {
    console.error("[edit] chat.list_sessions (page-bound) failed", {
      activePageId,
      error: sessionsR.error,
    });
  }
  if (!globalSessionsR.ok) {
    console.error("[edit] chat.list_sessions (global) failed", {
      error: globalSessionsR.error,
    });
  }
  const sessions = sessionsR.ok ? (sessionsR.value as { sessions: ChatSession[] }).sessions : [];
  const globalSessions = globalSessionsR.ok
    ? (globalSessionsR.value as { sessions: ChatSession[] }).sessions
    : [];

  const queryChat = url.searchParams.get("chat");
  // Active chat: explicit ?chat= wins (can be page-bound OR global) →
  // most-recent unpublished page-bound chat → auto-create page-bound.
  // Picking a global chat here is fine; the page iframe stays loaded
  // so the user can edit globally while looking at any page.
  let activeChat: ChatSession | null =
    sessions.find((s) => s.id === queryChat) ??
    globalSessions.find((s) => s.id === queryChat) ??
    sessions.find((s) => !s.publishedAt) ??
    null;
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
      } else {
        // v0.2.56 — the auto-create succeeded but the read-back failed.
        // Without this log, the only symptom was a 303 to /content/chat
        // with no breadcrumb. Almost always points to a schema-shape
        // mismatch (op output validator rejecting a row that the SQL
        // returned) — exactly the regression class introduced by
        // v0.2.54's session-row schema additions.
        console.error("[edit] chat.get_session failed after auto-create", {
          createdSessionId: id,
          error: fresh.error,
        });
      }
    } else {
      // v0.2.56 — auto-create failed. Surfaces RLS rejections, FK
      // violations, missing columns post-migration, etc.
      console.error("[edit] chat.create_session failed", {
        activePageId,
        error: created.error,
      });
    }
  }
  if (!activeChat) {
    // v0.2.56 — was a silent 303 redirect to /content/chat (matching
    // the user's "clicking on live edit gets me to chat" report).
    // Replaced with a 500 that names the symptom + points the
    // operator at /security/audit. Cloud Run stderr now has a
    // breadcrumb naming the failing op above.
    console.error("[edit] no active chat available — could not load OR create one", {
      sessionsLoaded: sessionsR.ok,
      globalSessionsLoaded: globalSessionsR.ok,
      activePageId,
      pagesCount: pages.length,
    });
    throw error(
      500,
      "Could not start a live-edit session — the chat ops returned no usable row. Check Cloud Run logs for `[edit]` stderr lines, or visit /security/audit.",
    );
  }

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
  // v0.2.76 — pre-loaded count of distinct entities (modules + pages
  // + templates + page-layout bindings) edited on this chat branch.
  // Initializes the toolbar's "N pending changes" badge so the count
  // survives a page reload. Pre-v0.2.76 the badge was a local
  // counter that incremented per AI tool result and reset to 0 on
  // every reload — confusing when real changes were live on the
  // branch.
  let branchChangeCount = 0;
  if (activeChat) {
    const editedR = await execute(registry, adapter, locals.ctx, "chat.branch_edited_modules", {
      chatSessionId: activeChat.id,
    });
    if (editedR.ok) {
      branchEditedModuleIds = (editedR.value as { moduleIds: string[] }).moduleIds;
    }
    const countR = await execute(registry, adapter, locals.ctx, "chat.branch_change_count", {
      chatSessionId: activeChat.id,
    });
    if (countR.ok) {
      branchChangeCount = (countR.value as { count: number }).count;
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
    branchChangeCount,
    layout,
    translationBanner,
    /** P6.7.4 — chats bound to the active page (for the picker's "this page" group). */
    pageChats: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      lastActiveAt: s.lastActiveAt,
      publishedAt: s.publishedAt,
    })),
    /** v0.2.14 — global chats (pageId IS NULL) for the picker's "global" group. */
    globalChats: globalSessions.map((s) => ({
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

    // v0.2.79 — derive the smallest possible changedPageIds from the
    // chat branch's edited entities. Without the cascade expansion
    // every Stage was a full-site rebuild — fine at dogfood scale,
    // but at 10k pages × 8 locales = 80k routes a typical edit would
    // re-bake 80k pages instead of the ~8 it actually affects.
    //
    // Lookup chain:
    //   active chat → branch_edited_entities → publish_impact_pages
    //   → union with the just-published pageId.
    //
    // Empty / no chat / fullSite → omit changedPageIds → triggerDeployOp
    // does a full-site rebuild (preserves pre-v0.2.79 behaviour for
    // non-chat-driven Stages).
    const chatId = String(form.get("chatId") ?? "") || null;
    let changedPageIds: string[] | undefined;
    if (chatId) {
      const entitiesR = await execute(
        registry,
        adapter,
        locals.ctx,
        "chat.branch_edited_entities",
        { chatSessionId: chatId },
      );
      if (entitiesR.ok) {
        const entities = entitiesR.value as {
          moduleIds: string[];
          pageIds: string[];
          templateIds: string[];
          pageLayoutPageIds: string[];
        };
        const impactR = await execute(
          registry,
          adapter,
          locals.ctx,
          "snapshots.publish_impact_pages",
          {
            moduleIds: entities.moduleIds,
            templateIds: entities.templateIds,
            // Per-page layout overrides surface as pageIds in the
            // edited-entities op; collapse them into the layoutIds
            // input position by passing them through as direct
            // pageIds (they don't fan out further).
            layoutIds: [],
          },
        );
        if (impactR.ok) {
          const impact = impactR.value as { pageIds: string[]; fullSite: boolean };
          if (!impact.fullSite) {
            const all = new Set<string>([
              ...impact.pageIds,
              ...entities.pageIds,
              ...entities.pageLayoutPageIds,
              pageId,
            ]);
            changedPageIds = [...all];
          }
        }
      }
    }

    const stagingDeploy = await execute(registry, adapter, locals.ctx, "deploy.trigger", {
      targetName: "staging",
      ...(changedPageIds && changedPageIds.length > 0 ? { changedPageIds } : {}),
    });
    if (!stagingDeploy.ok) {
      // v0.2.77 — surface the underlying generator error to the
      // operator instead of the previous opaque "Staging build
      // failed." Without the real message there's nowhere to look —
      // deploy_runs.error_message has the stderr but the toolbar
      // alert never pointed there.
      const reason = describeError(stagingDeploy.error);
      return fail(500, { error: `Staging build failed: ${reason}` });
    }

    const summary = stagingDeploy.value as {
      pageCount: number;
      fileCount: number;
      buildId: string;
      runId: string;
    };
    // v0.2.78 — on GCP installs the staged build lives in the private
    // staging bucket; the editor previews it through the IAP-gated
    // /_staging-preview/<runId>/<page-path>/ proxy. Self-hosted keeps
    // the existing CAELO_STAGING_BASE_URL (a separate Caddy serving
    // the bind-mounted staging out_dir).
    let previewUrl: string;
    if (process.env.CAELO_PROVIDER === "gcp") {
      // Look up the page's locale + slug to build the staged URL.
      // The static-generator emits each page as
      // `<locale>/<slug>/index.html` (locale-prefixed). The proxy
      // handles index.html when the path ends in `/`.
      const pageRow = await execute(registry, adapter, locals.ctx, "pages.get", { pageId });
      if (pageRow.ok) {
        const p = (pageRow.value as { page: { slug: string; locale: string } }).page;
        previewUrl = `/_staging-preview/${summary.runId}/${p.locale}/${p.slug}/`;
      } else {
        previewUrl = `/_staging-preview/${summary.runId}/`;
      }
    } else {
      previewUrl = process.env.CAELO_STAGING_BASE_URL ?? "http://localhost:8081";
    }
    return {
      staged: {
        pageId,
        pageCount: summary.pageCount,
        fileCount: summary.fileCount,
        buildId: summary.buildId,
        previewUrl,
      },
    };
  },
  /**
   * "+ New chat" creates a fresh page-bound OR global session and
   * redirects with `?chat=<id>` so the loader picks it up. An empty
   * `pageId` form value creates a global chat (pageId IS NULL); a
   * non-empty UUID binds the chat to that page so revisiting the page
   * later auto-resumes it.
   */
  newChat: async ({ request, locals, url }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const pageId = String(form.get("pageId") ?? "");
    const isGlobal = pageId.length === 0;
    const created = await execute(registry, adapter, locals.ctx, "chat.create_session", {
      title: isGlobal ? "Global chat" : "Page chat",
      ...(isGlobal ? {} : { pageId }),
    });
    if (!created.ok) return fail(500, { error: "Could not create chat." });
    const newId = (created.value as { chatSessionId: string }).chatSessionId;
    const next = new URL(url);
    next.searchParams.set("chat", newId);
    // Keep ?page= so the iframe still renders something even when the
    // chat itself is global (the user is editing layouts/menus while
    // looking at a representative page).
    if (!isGlobal) next.searchParams.set("page", pageId);
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
