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
import { stagingPreviewPath } from "$lib/server/staging-preview-path.js";
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
  // most-recent unpublished page-bound chat → most-recent unpublished
  // GLOBAL chat (v0.3.23) → auto-create page-bound. Picking a global
  // chat here is fine; the page iframe stays loaded so the user can
  // edit globally while looking at any page.
  //
  // v0.3.23 — fallback extended to globalSessions. On fresh installs
  // the AI's first chat is global (pageId=null, no pages yet). After
  // the AI creates the home page and the user reloads, the page-bound
  // fallback misses the AI's chat (it's global, not bound to home),
  // and a NEW session was auto-created with a fresh branch — losing
  // every uncommitted change. The 4th fallback line resumes the AI's
  // global session so its branch (and Stage button) come back.
  let activeChat: ChatSession | null =
    sessions.find((s) => s.id === queryChat) ??
    globalSessions.find((s) => s.id === queryChat) ??
    sessions.find((s) => !s.publishedAt) ??
    globalSessions.find((s) => !s.publishedAt) ??
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

  // v0.8.0 — cross-chat awareness: other open chats with pending
  // edits. Surface in a thin banner above the toolbar so unstaged
  // work on other pages doesn't get forgotten when navigating.
  type OtherChat = {
    chatSessionId: string;
    title: string;
    anchorPageId: string | null;
    anchorPageSlug: string | null;
    anchorPageLocale: string | null;
    pendingCount: number;
  };
  let otherOpenChats: OtherChat[] = [];
  if (activeChat) {
    const othersR = await execute(registry, adapter, locals.ctx, "chat.list_open_with_pending", {
      excludeChatSessionId: activeChat.id,
    });
    if (othersR.ok) {
      otherOpenChats = (othersR.value as { chats: OtherChat[] }).chats;
    }
  }

  // v0.8.0 — last successful staging deploy timestamp + preview URL,
  // shown atop the Promote modal so the operator knows what they're
  // about to push to production. Best-effort; missing data renders no
  // header. We fetch a small recent window since deploy.list_runs
  // doesn't filter by target — pick the newest staging+succeeded.
  let lastStaged: { runId: string; finishedAt: string; previewUrl: string | null } | null = null;
  try {
    const recentR = await execute(registry, adapter, locals.ctx, "deploy.list_runs", {
      limit: 20,
    });
    if (recentR.ok) {
      const v = recentR.value as {
        runs: {
          id: string;
          targetName: string;
          status: string;
          finishedAt: string | null;
          publishSummary?: { previewUrl?: string };
        }[];
      };
      const r = v.runs.find(
        (row) => row.targetName === "staging" && row.status === "succeeded" && row.finishedAt,
      );
      if (r && r.finishedAt) {
        lastStaged = {
          runId: r.id,
          finishedAt: r.finishedAt,
          previewUrl: r.publishSummary?.previewUrl ?? null,
        };
      }
    }
  } catch {
    // deploy.list_runs unregistered on some dev installs — fine.
  }

  // v0.7.0 — categorized pending/staged view feeding the per-kind
  // dropdown on the overlay's StageDeployButton (Pages / Modules /
  // Templates / Lists). Empty default when no chat is active (rare —
  // auto-create above usually provides one).
  type PendingEntity = { kind: string; entityId: string; label: string; detail?: string };
  type PendingChangesView = {
    pending: { pages: PendingEntity[]; globals: PendingEntity[]; lists: PendingEntity[] };
    staged: { pages: PendingEntity[]; globals: PendingEntity[]; lists: PendingEntity[] };
  };
  let pendingChanges: PendingChangesView = {
    pending: { pages: [], globals: [], lists: [] },
    staged: { pages: [], globals: [], lists: [] },
  };
  if (activeChat) {
    const pR = await execute(registry, adapter, locals.ctx, "chat.list_pending_changes", {
      chatSessionId: activeChat.id,
    });
    if (pR.ok) pendingChanges = pR.value as PendingChangesView;
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
    pendingChanges,
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
    /** v0.8.0 — other open chats with pending edits, for the cross-chat banner. */
    otherOpenChats,
    /** v0.8.0 — last successful staging deploy summary, for the Promote modal header. */
    lastStaged,
  };
};

/**
 * /edit form actions. v0.7.1 dropped the legacy per-page `?/stage`
 * + `?/confirmPublish` chain in favor of the chat-branch-aware
 * `?/stageAndDeployStaging` + `?/publishToProduction` pair below —
 * the toolbar Stage / Confirm-publish buttons were retired alongside
 * those actions since the overlay's StageDeployButton is now the
 * single Stage/Publish surface.
 */
export const actions: Actions = {
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

    // v0.5.8 — per-page gate. If the page already has an open chat,
    // resume it instead of failing on the server-side reject. Keeps
    // the "+ New chat" button useful even when a stale tab created a
    // page-bound chat the user forgot about.
    if (!isGlobal) {
      const active = await execute(registry, adapter, locals.ctx, "chat.list_active_pages", {});
      if (active.ok) {
        const v = active.value as {
          pages: { pageId: string; chatSessionId: string }[];
        };
        const existing = v.pages.find((p) => p.pageId === pageId);
        if (existing) {
          const next = new URL(url);
          next.searchParams.set("chat", existing.chatSessionId);
          next.searchParams.set("page", pageId);
          throw redirect(303, `${next.pathname}${next.search}`);
        }
      }
    }

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
  /**
   * v0.7.0 — /edit's split-button Stage path. One click does the full
   * "show me 1:1 what production would see" loop:
   *
   *   1. chat.merge_to_main — promote every branch-snapshot to main
   *      live tables, WITHOUT closing the chat (no published_at stamp,
   *      no lock release). Safe to call repeatedly as the operator
   *      iterates; each call re-promotes whatever's currently latest.
   *   2. deploy.trigger(staging) — full-site rebuild against the now-
   *      merged main state. Filtering staging deploys to changedPageIds
   *      would defeat the "1:1 preview" promise: chrome (header/footer)
   *      lives in layouts, and a module-only re-bake misses pages whose
   *      template references the changed module indirectly. The Stage
   *      gesture says "make staging match main"; full rebuild does that
   *      with the fewest gotchas. Selective filtering is the production
   *      Publish path (?/publishToProduction) where minutes matter more
   *      than precision.
   *
   * Returns `{ staged: { previewUrl, ... } }` so the same toast/iframe-
   * reload pattern as ?/stage works unchanged.
   */
  stageAndDeployStaging: async ({ request, locals }) => {
    requirePermission(locals, "deploy.trigger");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const chatSessionId = String(form.get("chatSessionId") ?? "");
    if (!chatSessionId) return fail(400, { error: "missing chatSessionId" });
    const pageId = String(form.get("pageId") ?? "");

    const merged = await execute(registry, adapter, locals.ctx, "chat.merge_to_main", {
      chatSessionId,
    });
    if (!merged.ok) {
      return fail(500, { error: `Merge to main failed: ${describeError(merged.error)}` });
    }

    const stagingDeploy = await execute(registry, adapter, locals.ctx, "deploy.trigger", {
      targetName: "staging",
    });
    if (!stagingDeploy.ok) {
      return fail(500, { error: `Staging build failed: ${describeError(stagingDeploy.error)}` });
    }

    const summary = stagingDeploy.value as {
      pageCount: number;
      fileCount: number;
      buildId: string;
      runId: string;
      previewUrl?: string;
    };
    let previewUrl: string;
    if (summary.previewUrl) {
      previewUrl = summary.previewUrl;
    } else if (process.env.CAELO_PROVIDER === "gcp" && pageId) {
      const pageRow = await execute(registry, adapter, locals.ctx, "pages.get", { pageId });
      const localesR = await execute(registry, adapter, locals.ctx, "locales.list", {});
      if (pageRow.ok && localesR.ok) {
        const p = (pageRow.value as { page: { slug: string; locale: string } }).page;
        const locales = (
          localesR.value as {
            locales: { code: string; urlStrategy: string; urlHost: string | null }[];
          }
        ).locales;
        const cfg = locales.find((l) => l.code === p.locale);
        previewUrl = `/_staging-preview/${summary.runId}/${stagingPreviewPath(p.slug, cfg)}`;
      } else {
        previewUrl = `/_staging-preview/${summary.runId}/`;
      }
    } else {
      previewUrl = process.env.CAELO_STAGING_BASE_URL ?? "http://localhost:8081";
    }

    const mergedSummary = merged.value as { entityCount: number };
    return {
      staged: {
        pageId,
        pageCount: summary.pageCount,
        fileCount: summary.fileCount,
        buildId: summary.buildId,
        previewUrl,
        mergedEntityCount: mergedSummary.entityCount,
      },
    };
  },
  /**
   * v0.7.0 — production publish from the split-button dropdown. The
   * operator picks which entity kinds graduate to production via
   * checkboxes; we resolve those kinds to a precise page-id set and
   * pass it to deploy.trigger so the static-generator re-bakes only
   * the affected routes. Unchecked-kind pages keep their existing
   * production HTML.
   *
   * Kind options surfaced in the picker:
   *   - "pages"     — page metadata (slug, title, status) + per-page
   *                   layout + per-placement content edits
   *   - "modules"   — module HTML/CSS/JS/fields edits
   *   - "templates" — template body / block layout changes
   *   - "lists"     — structured-set blob promotion (menu, taxonomy)
   *
   * The "lists" kind today fans out to a full-site rebuild because
   * templates reference menus implicitly (per snapshots.publish_impact_pages
   * fast-path). That's the safe conservative behavior until we add a
   * template_set_refs index — same posture as the existing Stage flow.
   *
   * Resolution path:
   *   chat.branch_edited_entities (entity ids the chat touched)
   *   → filter to ids whose kind is in the operator's checked set
   *   → snapshots.publish_impact_pages (module/template/layout → pages)
   *   → union with direct page edits (page + pageLayout snapshot rows)
   *   → pass to deploy.trigger as changedPageIds.
   *
   * If every kind is checked OR no kinds are checked, the deploy runs
   * unfiltered (full rebuild) so the operator can't accidentally ship
   * an empty diff.
   */
  publishToProduction: async ({ request, locals }) => {
    requirePermission(locals, "deploy.trigger");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const chatSessionId = String(form.get("chatSessionId") ?? "") || null;
    const rawKinds = form.getAll("kind").map((k) => String(k));
    type KindGroup = "pages" | "modules" | "templates" | "lists" | "layoutChrome";
    const allowed: ReadonlyArray<KindGroup> = [
      "pages",
      "modules",
      "templates",
      "lists",
      "layoutChrome",
    ];
    const checked = new Set<KindGroup>(
      rawKinds.filter((k): k is KindGroup => (allowed as ReadonlyArray<string>).includes(k)),
    );

    let changedPageIds: string[] | undefined;
    // v0.8.0 — layoutChrome edits affect every page using the layout
    // (header/footer/nav cascade through templates), so checking it
    // forces a full-site rebuild the same as the existing lists path.
    const fullRebuild =
      checked.size === 0 ||
      checked.size === allowed.length ||
      checked.has("lists") ||
      checked.has("layoutChrome");

    if (!fullRebuild && chatSessionId) {
      const entitiesR = await execute(
        registry,
        adapter,
        locals.ctx,
        "chat.branch_edited_entities",
        { chatSessionId },
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
            moduleIds: checked.has("modules") ? entities.moduleIds : [],
            templateIds: checked.has("templates") ? entities.templateIds : [],
            layoutIds: [],
          },
        );
        const all = new Set<string>();
        if (impactR.ok) {
          const impact = impactR.value as { pageIds: string[]; fullSite: boolean };
          if (impact.fullSite) {
            // Defensive fallback — publish_impact_pages currently only
            // returns fullSite for structured-set edits, which we routed
            // through `fullRebuild` above. Reaching this branch means
            // the impact op gained another fan-out we don't know about;
            // skip the filter so the deploy is conservatively complete.
            changedPageIds = undefined;
          } else {
            for (const id of impact.pageIds) all.add(id);
          }
        }
        if (checked.has("pages")) {
          for (const id of entities.pageIds) all.add(id);
          for (const id of entities.pageLayoutPageIds) all.add(id);
        }
        if (changedPageIds === undefined && all.size > 0) {
          changedPageIds = [...all];
        }
      }
    }

    const productionDeploy = await execute(registry, adapter, locals.ctx, "deploy.trigger", {
      targetName: "production",
      ...(changedPageIds && changedPageIds.length > 0 ? { changedPageIds } : {}),
    });
    if (!productionDeploy.ok) {
      return fail(500, {
        error: `Production build failed: ${describeError(productionDeploy.error)}`,
      });
    }

    const summary = productionDeploy.value as {
      pageCount: number;
      fileCount: number;
      buildId: string;
      runId: string;
    };
    return {
      published: {
        targetName: "production",
        pageCount: summary.pageCount,
        fileCount: summary.fileCount,
        buildId: summary.buildId,
        kinds: [...checked],
        ...(changedPageIds ? { changedPageCount: changedPageIds.length } : {}),
      },
    };
  },
};
