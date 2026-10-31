// SPDX-License-Identifier: MPL-2.0

import { describeError, stageChatSessions } from "@caelo-cms/admin-core";
import { loadedPlugins } from "@caelo-cms/plugin-host";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { error, fail, redirect } from "@sveltejs/kit";
import { groupAgentChats } from "#lib/agent-chat-groups.js";
import type { ChatMessage, ChatSession } from "#lib/components/chat/types.js";
import {
  DEFAULT_LAYOUT,
  type OverlayLayout,
} from "#lib/components/edit/use-overlay-layout.svelte.js";
import { loadTranscriptPage } from "#lib/server/chat-transcript.js";
import { assertCsrfToken } from "#lib/server/csrf.js";
import {
  activePageScope,
  type EditPage,
  pickActivePage,
  toEditPage,
} from "#lib/server/edit-active-page.js";
import { streamEditorParts } from "#lib/server/edit-streamed.js";
import { requirePermission, requireUser } from "#lib/server/guards.js";
import { opErrorMessage } from "#lib/server/op-error.js";
import { loadEditorToolbar } from "#lib/server/plugin-toolbar.js";
import { pluginWorkflowSuggestions } from "#lib/server/plugin-workflows.js";
import { publishChangedPages } from "#lib/server/publish-changed-pages.js";
import { getQueryContext } from "#lib/server/query.js";
import { ServerTiming } from "#lib/server/server-timing.js";
import { describeStagedBuild } from "#lib/server/stage-result.js";
import type { Actions, PageServerLoad } from "./$types";

/**
 * issue #187 — the server-authored first assistant turn on untouched
 * installs. Three entry points, answered conversationally — the
 * operator never fills a form (CLAUDE.md §1A). Keep in sync with the
 * cold-start routing in admin-core's `formatSiteIdentityBlock`.
 */
const FIRST_RUN_WELCOME = [
  "**Welcome — let's set up your website.** I'm the AI that builds and runs this site with you: you describe, I do the work, you approve the big steps.",
  "",
  "Pick one of the options below, or just tell me in your own words:",
  "",
  "1. **You already have a website** — I'll look at it, we keep or refresh its design, and I migrate content and URLs.",
  "2. **Starting from scratch** — tell me what the site is for; I'll propose complete design directions and you pick.",
  "3. **You already have a design** — drop a mockup image or HTML into the chat and I'll build on exactly that.",
].join("\n");

/**
 * Quick-reply chips ChatPanel renders under the welcome until the
 * first user turn. Clicking SENDS the message — the entry-point
 * choice costs one click, not a typed paragraph (CLAUDE.md §1A).
 */
const FIRST_RUN_SUGGESTIONS = [
  {
    label: "I already have a website",
    message: "I have an existing website that I'd like to migrate to Caelo.",
  },
  {
    label: "Start from scratch",
    message: "I'm starting from scratch — let's design a brand-new site.",
  },
  {
    label: "I already have a design",
    message: "I already have a design (mockup or HTML) that the site should be built on.",
  },
];

/**
 * #1102 — the notice for a `?chat=` Live Edit could not open: the chat was
 * archived (a discard archives too) or is not one this operator can open.
 * Names the chat that was opened instead.
 */
async function describeUnopenedChat(
  chatSessionId: string,
  openedTitle: string,
  ctx: ExecutionContext,
): Promise<string> {
  const { adapter, registry } = getQueryContext();
  const asked = UUID_RE.test(chatSessionId)
    ? await execute(registry, adapter, ctx, "chat.resolve_session", { chatSessionId })
    : null;
  const session = asked?.ok
    ? (asked.value as { session: { title: string; archivedAt: string | null } }).session
    : null;
  const opened = `opened “${openedTitle}” instead`;
  if (session?.archivedAt) {
    return `The chat “${session.title}” was closed, so it can take no more changes; Live Edit ${opened}. Continue here, or pick or start another chat in the chat list.`;
  }
  return `The chat in this link was not found; Live Edit ${opened}. Continue here, or pick or start another chat in the chat list.`;
}

/**
 * #1201 — the caller's open chat on `pageId` (the one the per-page gate in
 * `chat.create_session` refuses a second chat for), loaded for Live Edit;
 * null when there is none or it cannot be read.
 */
async function resumeOpenPageChat(
  pageId: string,
  ctx: ExecutionContext,
): Promise<ChatSession | null> {
  const { adapter, registry } = getQueryContext();
  const active = await execute(registry, adapter, ctx, "chat.list_active_pages", {});
  if (!active.ok) return null;
  const held = (active.value as { pages: { pageId: string; chatSessionId: string }[] }).pages.find(
    (p) => p.pageId === pageId,
  );
  if (!held) return null;
  const session = await execute(registry, adapter, ctx, "chat.resolve_session", {
    chatSessionId: held.chatSessionId,
  });
  return session.ok ? (session.value as { session: ChatSession }).session : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Runs one first-paint op; a refusal fails the load with the op's reason (CLAUDE.md §2). */
async function readOrFail<T>(ctx: ExecutionContext, op: string, input: unknown): Promise<T> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, ctx, op, input);
  if (!r.ok) {
    console.error(`[edit] ${op} failed`, { error: r.error });
    throw error(500, `Live Edit could not open: ${opErrorMessage(r.error, `${op} failed`)}.`);
  }
  return r.value as T;
}

/**
 * The page to open as `ctx` sees it, from the `?page=`/home lookup; only a
 * site without either reads its whole page list (to open the first page).
 * `all` is that list when it was read.
 */
async function resolveActivePage(
  ctx: ExecutionContext,
  queryPage: string | null,
): Promise<{ page: EditPage | null; candidates: EditPage[]; all: EditPage[] | null }> {
  const scoped = await readOrFail<{ pages: EditPage[] }>(
    ctx,
    "pages.list",
    activePageScope(queryPage),
  );
  const candidates = scoped.pages.map(toEditPage);
  const page = pickActivePage(candidates, queryPage);
  if (page) return { page, candidates, all: null };
  const all = (await readOrFail<{ pages: EditPage[] }>(ctx, "pages.list", {})).pages.map(
    toEditPage,
  );
  return { page: pickActivePage(all, queryPage), candidates, all };
}

/**
 * #1268 — first paint awaits only what it shows: the page, the chat and the
 * chat's newest transcript page. Everything else streams in
 * (`streamEditorParts`), so a slow read delays its own spot, not the editor.
 * The awaited steps' durations go out as `Server-Timing`.
 */
export const load: PageServerLoad = async ({ locals, url, setHeaders }) => {
  // Login lands everyone here (the chat IS the product). The rare
  // ops-only role without content.write gets the dashboard instead of
  // a 403 wall — /edit is a front door, not a fence.
  const editUser = requireUser(locals);
  if (!editUser.permissions.has("content.write")) throw redirect(303, "/");
  const { adapter, registry } = getQueryContext();
  const timing = new ServerTiming();
  const queryPage = url.searchParams.get("page");

  // The page in main's view first: the chats to resume are scoped by it.
  // The overlay layout preference is read alongside.
  const [main, prefsR] = await timing.time("page-main", () =>
    Promise.all([
      resolveActivePage(locals.ctx, queryPage),
      execute(registry, adapter, locals.ctx, "user_preferences.get", {
        key: "edit_overlay_layout",
      }),
    ]),
  );
  let activePage = main.page;
  let activePageId = activePage?.id ?? null;

  // P6.7.4 / v0.2.14 — chats are scoped two ways:
  //   - page-bound (`pageId = <activePageId>`): "this page's chats",
  //     auto-resume on revisit, used for content edits scoped to one
  //     page.
  //   - global (`pageId IS NULL`): cross-cutting work like layout /
  //     menu / footer changes that aren't tied to one page.
  // Both buckets are loaded in parallel and surfaced in the overlay's
  // chat picker. Form action `?/newChat` accepts an empty `pageId` to
  // create a global chat.
  // #1253 — the operator's own chats only: an external agent works in a
  // chat of its own, which Live Edit never picks as the operator's. The
  // agents' chats are listed apart, grouped per client.
  const [sessionsR, globalSessionsR, agentSessionsR] = await timing.time("chats", () =>
    Promise.all([
      execute(registry, adapter, locals.ctx, "chat.list_sessions", {
        includeArchived: false,
        pageId: activePageId,
        agentChats: "exclude",
      }),
      execute(registry, adapter, locals.ctx, "chat.list_sessions", {
        includeArchived: false,
        pageId: null,
        agentChats: "exclude",
      }),
      execute(registry, adapter, locals.ctx, "chat.list_sessions", {
        includeArchived: false,
        agentChats: "only",
      }),
    ]),
  );
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
  if (!agentSessionsR.ok) {
    console.error("[edit] chat.list_sessions (agents) failed", { error: agentSessionsR.error });
  }
  const agentSessions = agentSessionsR.ok
    ? (agentSessionsR.value as { sessions: ChatSession[] }).sessions
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
    // #1253 — an agent's chat opens only when named explicitly.
    agentSessions.find((s) => s.id === queryChat) ??
    sessions.find((s) => !s.publishedAt) ??
    globalSessions.find((s) => !s.publishedAt) ??
    null;
  // #1201 — why the auto-create below was refused, when the op refused it
  // (a HandlerError carries an operator-readable reason). Turns the dead end
  // into a 409 that says what to do instead of a bare 500.
  let createRefusal: string | null = null;
  if (!activeChat) {
    const created = await timing.time("chat-create", () =>
      execute(registry, adapter, locals.ctx, "chat.create_session", {
        title: activePage ? `Live edit · ${activePage.slug}` : "Live edit",
        ...(activePageId ? { pageId: activePageId } : {}),
      }),
    );
    if (created.ok) {
      const id = (created.value as { chatSessionId: string; chatBranchId: string }).chatSessionId;
      const fresh = await execute(registry, adapter, locals.ctx, "chat.resolve_session", {
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
        console.error("[edit] chat.resolve_session failed after auto-create", {
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
      if (created.error.kind === "HandlerError") {
        createRefusal = opErrorMessage(created.error, "the chat could not be created");
        // #1201 — the per-page gate refuses only for an open chat of this
        // operator on this page, and `chat.list_active_pages` lists exactly
        // that chat. The session lists above can miss it — another tab
        // created it in between, or newer published chats on the page
        // filled the list's 100 rows — so resume it from there instead of
        // failing.
        if (activePageId) activeChat = await resumeOpenPageChat(activePageId, locals.ctx);
      }
    }
  }
  if (!activeChat && createRefusal) {
    // #1201 — a refusal is not a server fault: say why and where to go on.
    throw error(
      409,
      `Live Edit could not open a chat for this page: ${createRefusal}. Pick a chat in the chat list, or open Content → Changes to see every open chat with unstaged changes.`,
    );
  }
  if (!activeChat) {
    // v0.2.56 — was a silent 303 redirect to /content/chat (matching
    // the user's "clicking on live edit gets me to chat" report).
    // Replaced with a 500 that names the symptom + points the
    // operator at /settings/audit. Cloud Run stderr now has a
    // breadcrumb naming the failing op above.
    console.error("[edit] no active chat available — could not load OR create one", {
      sessionsLoaded: sessionsR.ok,
      globalSessionsLoaded: globalSessionsR.ok,
      activePageId,
    });
    throw error(
      500,
      "Could not start a live-edit session — the chat ops returned no usable row. Check Cloud Run logs for `[edit]` stderr lines, or visit /settings/audit.",
    );
  }
  const chat = activeChat;

  // v0.9.3 — branch-aware ctx so every downstream entity read (pages,
  // modules, translation-source lookup) includes rows the AI created on
  // this chat's branch. v0.9.0 added `branchVisibilityFilter(ctx)` to
  // every list/get op; without `chatBranchId` set, the filter hides
  // branched rows.
  const ctxWithBranch: ExecutionContext = { ...locals.ctx, chatBranchId: chat.chatBranchId };

  // The page again in the chat's view — on a fresh install the AI's new
  // home exists only on the branch — next to the chat's newest transcript
  // page (#1216: ChatPanel loads older pages on demand). #1102 — an
  // explicit `?chat=` that names no open chat (archived, discarded, or not
  // this operator's) is not resumed; the notice says so instead of silently
  // showing another chat's branch (CLAUDE.md §2).
  const [branch, transcript, chatNotice] = await timing.time("page-branch+transcript", () =>
    Promise.all([
      resolveActivePage(ctxWithBranch, queryPage),
      loadTranscriptPage(locals.ctx, chat.id),
      queryChat && queryChat !== chat.id
        ? describeUnopenedChat(queryChat, chat.title, locals.ctx)
        : Promise.resolve(null),
    ]),
  );
  activePage = branch.page;
  activePageId = activePage?.id ?? null;
  let messages: ChatMessage[] = transcript?.messages ?? [];
  let hasMoreMessages = transcript?.hasMore ?? false;

  // issue #187 — first-run welcome. On an untouched install (no pages,
  // no site identity) an empty chat is a dead end: the operator doesn't
  // know the three entry points exist. Seed ONE assistant message
  // presenting them, persisted via the normal message op so it renders,
  // survives reloads, and lands in the AI's own transcript context.
  // The `messages.length === 0` guard makes the seed idempotent per
  // chat; once identity or pages exist the branch never fires again.
  let firstRunSuggestions: typeof FIRST_RUN_SUGGESTIONS = [];
  let pluginSuggestions: typeof FIRST_RUN_SUGGESTIONS = [];
  if (!messages.some((m) => m.role === "user")) {
    const visible = await timing.time("suggestions", () =>
      execute(registry, adapter, locals.ctx, "skills.list", { status: "active" }),
    );
    if (visible.ok) {
      const skills = (
        visible.value as {
          skills: { slug: string; displayName: string; activatedAt: string | null }[];
        }
      ).skills;
      const slugs = new Set(
        loadedPlugins
          .all()
          .flatMap((plugin) => (plugin.definition.skills ?? []).map((skill) => skill.slug)),
      );
      pluginSuggestions = pluginWorkflowSuggestions(skills, slugs);
      firstRunSuggestions = pluginSuggestions;
    }
  }
  // No page in the chat's view at all: `resolveActivePage` read the whole
  // list and it is empty.
  if (activePage === null) {
    const defaultsR = await execute(registry, adapter, locals.ctx, "site_defaults.get", {});
    const identity = defaultsR.ok
      ? (
          defaultsR.value as {
            defaults: { siteName: string | null; sitePurpose: string | null } | null;
          }
        ).defaults
      : null;
    const untouched = !identity?.siteName && !identity?.sitePurpose;
    // Chips render until the FIRST user turn (also across reloads).
    // Not gated on `untouched`: an install can carry identity but zero
    // pages (wiped content, aborted migrate) — an empty chat there is
    // the same dead end (live-hit 2026-07-12). The seeded welcome
    // below KEEPS the untouched gate; its cold-start entry-point pitch
    // would be stale advice on an install with identity.
    if (!messages.some((m) => m.role === "user")) {
      firstRunSuggestions = [...pluginSuggestions, ...FIRST_RUN_SUGGESTIONS];
    }
    if (untouched && messages.length === 0) {
      const seeded = await execute(registry, adapter, locals.ctx, "chat.append_message", {
        chatSessionId: chat.id,
        role: "assistant",
        content: pluginSuggestions.length
          ? "**Welcome — what would you like to create?** Describe your goal, or choose one of the available workflows below. I'll guide you through it."
          : FIRST_RUN_WELCOME,
        // issue #303 — producer hint for the empty-content rejection.
        source: "first-run welcome seed (/edit)",
      });
      if (seeded.ok) {
        const reread = await loadTranscriptPage(locals.ctx, chat.id);
        if (reread) {
          messages = reread.messages;
          hasMoreMessages = reread.hasMore;
        }
      } else {
        console.error("[edit] first-run welcome seed failed", { error: seeded.error });
      }
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

  // The plugin places in the toolbar for the shown page, in this chat's
  // view. Streamed: plugin operations must not hold up the editor.
  const pluginToolbar = activePage
    ? loadEditorToolbar({
        permissions: editUser.permissions,
        pageId: activePage.id,
        chatBranchId: chat.chatBranchId,
      })
    : Promise.resolve([]);

  const stream = streamEditorParts({
    ctx: locals.ctx,
    branchCtx: ctxWithBranch,
    chatSessionId: chat.id,
    activePage,
    mainCandidates: main.candidates,
    branchPages: branch.all,
  });

  setHeaders({ "server-timing": timing.header() });
  return {
    activePageId,
    /** #1268 — the shown page, so first paint needs no page list. */
    activePage,
    activeChat: chat,
    /** #1102 — why the `?chat=` in the URL was not opened, or null. */
    chatNotice,
    messages,
    hasMoreMessages,
    firstRunSuggestions,
    layout,
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
    /** #1253 — external agents' chats, one group per client app. */
    agentChatGroups: groupAgentChats(
      agentSessions.map((s) => ({
        id: s.id,
        title: s.title,
        lastActiveAt: s.lastActiveAt,
        publishedAt: s.publishedAt,
        agentClient: s.agentClient ?? null,
      })),
    ).agents,
    /** The plugin places in the toolbar for the shown page (streamed). */
    pluginToolbar,
    // #1268 — streamed: each resolves to its value or why it failed.
    pages: stream.pages,
    recentPageIds: stream.recentPageIds,
    modules: stream.modules,
    branchEditedModuleIds: stream.branchEditedModuleIds,
    branchChangeCount: stream.branchChangeCount,
    pendingChanges: stream.pendingChanges,
    otherOpenChats: stream.otherOpenChats,
    deployState: stream.deployState,
    live: stream.live,
    pageSeo: stream.pageSeo,
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
    // Issue #620 — chats share the site draft; an experiment is explicit.
    const experiment = form.get("isolation") === "experiment";

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
      title: experiment ? "Experiment" : isGlobal ? "Global chat" : "Page chat",
      ...(isGlobal ? {} : { pageId }),
      ...(experiment ? { isolation: "experiment" } : {}),
    });
    if (!created.ok) {
      // #1201 — a refusal names its reason and the next step; only an
      // unexpected failure stays a 500.
      return created.error.kind === "HandlerError"
        ? fail(409, { error: opErrorMessage(created.error, "Could not create chat.") })
        : fail(500, { error: "Could not create chat." });
    }
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
   * v0.9.9 — flip the active page's `status` between `draft` and
   * `published`. Drafts are LIVE-EDIT ONLY; Stage and Production
   * deploys filter to `status='published'` (see static-generator's
   * status filter). The toolbar toggle in /edit calls this so the
   * editor can ship a page (draft→published) or pull one back
   * (published→draft) without touching `pages.update` directly.
   *
   * v0.9.12 — calls the dedicated `pages.set_status` op (not
   * `pages.update`). The op does TWO writes in one tx:
   *
   *   1. UPDATE the live `pages` row so `pages.list` (and the toolbar
   *      badge) reflects the new status immediately.
   *   2. PATCH the latest branched `page_snapshots.state.status` for
   *      this page on the active chat's branch — without this,
   *      `chat.merge_to_main` UPSERTs from the stale snapshot at Stage
   *      and reverts the status back to whatever the AI's create-time
   *      snapshot had ('draft' by default).
   *
   * v0.9.11 only did (1) — the badge flipped but Stage reverted.
   * v0.9.10 only did (2) (via pages.update branched path) — Stage
   * worked but the badge stayed stale. The dedicated op covers both.
   */
  setPageStatus: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const pageId = String(form.get("pageId") ?? "");
    const status = String(form.get("status") ?? "");
    const chatBranchId = String(form.get("chatBranchId") ?? "");
    // Issue #620 — the write belongs to the active chat: on the shared draft
    // the branch alone does not say whose change it is.
    const chatSessionId = String(form.get("chatSessionId") ?? "");
    if (!pageId) return fail(400, { error: "missing pageId" });
    if (status !== "draft" && status !== "published") {
      return fail(400, { error: "status must be 'draft' or 'published'" });
    }
    const ctx: ExecutionContext = chatBranchId
      ? { ...locals.ctx, chatBranchId, ...(chatSessionId ? { chatTaskId: chatSessionId } : {}) }
      : locals.ctx;
    const r = await execute(registry, adapter, ctx, "pages.set_status", {
      pageId,
      status,
    });
    // Issue #569 — the form named a branch this operator may not see.
    if (!r.ok && r.error.kind === "BranchNotFound") return fail(404, { error: "Branch not found" });
    if (!r.ok) {
      // v0.10.4 — log full error to stderr so the Cloud Run operator can
      // see the underlying SQL/PG detail. The toast renders the stripped
      // describeError() version, which loses pgDetail.message when only
      // the bun-postgres `code` is set.
      console.error("[setPageStatus] op failed", {
        pageId,
        status,
        chatBranchId: chatBranchId || null,
        error: r.error,
      });
      return fail(500, { error: `Could not update status: ${describeError(r.error)}` });
    }
    // `ok` string is picked up by the (authed) layout's $effect to fire
    // a toast; pageId + status are returned so per-route consumers
    // could read them off `form` if needed.
    return {
      ok: status === "published" ? "Page published." : "Page set to draft.",
      pageId,
      status,
    };
  },
  /**
   * #917 / #918 — in-place edits from the preview iframe: one or more
   * values of one placement (text, link target, image), written on the
   * active chat's branch through `page_module_content.patch_fields`
   * (snapshot, so chat Undo reverts it). `scope` answers "everywhere or
   * only here?" for shared content. The page posts here with fetch +
   * `applyAction`, so the layout's toast effect reports the outcome.
   */
  editFields: async ({ request, locals }) => {
    requirePermission(locals, "content.write");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const chatBranchId = String(form.get("chatBranchId") ?? "");
    const chatSessionId = String(form.get("chatSessionId") ?? "");
    let edits: unknown;
    try {
      edits = JSON.parse(String(form.get("edits") ?? ""));
    } catch {
      return fail(400, { error: "Not saved: the change could not be read." });
    }
    const scope = form.get("scope");
    const ctx: ExecutionContext = chatBranchId
      ? { ...locals.ctx, chatBranchId, ...(chatSessionId ? { chatTaskId: chatSessionId } : {}) }
      : locals.ctx;
    // The op's Zod schema validates the shape; a malformed post fails there.
    const r = await execute(registry, adapter, ctx, "page_module_content.patch_fields", {
      pageId: String(form.get("pageId") ?? ""),
      blockName: String(form.get("blockName") ?? ""),
      position: Number(form.get("position")),
      edits,
      ...(typeof scope === "string" && scope.length > 0 ? { scope } : {}),
    });
    if (!r.ok && r.error.kind === "BranchNotFound") return fail(404, { error: "Branch not found" });
    if (!r.ok) {
      // HandlerError messages are written for the operator; other kinds
      // (validation, lock) go through describeError.
      const message =
        r.error.kind === "HandlerError" && "message" in r.error
          ? String(r.error.message)
          : describeError(r.error);
      return fail(r.error.kind === "HandlerError" ? 409 : 400, { error: `Not saved: ${message}` });
    }
    // `savedAt` makes every save a distinct result: the layout's toast
    // effect skips a form result identical to the previous one, which would
    // swallow the confirmation of a second edit in a row.
    return { ok: "Saved.", savedAt: new Date().toISOString() };
  },
  /**
   * v0.7.0 — /edit's split-button Stage path. One click does the full
   * "show me 1:1 what production would see" loop:
   *
   *   1. chat.merge_to_main (deferConsume) — promote branch snapshots
   *      created since the last successful Stage to main live tables,
   *      WITHOUT closing the chat (no published_at stamp, no lock
   *      release) and WITHOUT consuming the branch (no last_staged_at
   *      stamp yet). Safe to call repeatedly; a retry after a failed
   *      build re-promotes the same set (nothing was consumed), and a
   *      re-Stage after new edits promotes only those edits (issue
   *      #262 — lifetime replay bumped updated_at on every entity the
   *      chat ever touched).
   *   2. deploy.trigger(staging) — full-site rebuild against the now-
   *      merged main state. Filtering staging deploys to changedPageIds
   *      would defeat the "1:1 preview" promise: chrome (header/footer)
   *      lives in layouts, and a module-only re-bake misses pages whose
   *      template references the changed module indirectly. The Stage
   *      gesture says "make staging match main"; full rebuild does that
   *      with the fewest gotchas. Selective filtering is the production
   *      Publish path (?/publishToProduction) where minutes matter more
   *      than precision.
   *   3. chat.finalize_stage — ONLY when the build succeeded: stamp
   *      last_staged_at (to the merge timestamp) + release locks, which
   *      is what resets the pending counter and swaps Stage for the
   *      publish-only toolbar.
   *
   * Run #8 R6 (issue #262): pre-fix, step 1 consumed the branch
   * up-front, so a FAILED staging build left the chat with no pending
   * changes, no Stage button, and no retry path — the branch was spent
   * on a build that never shipped. The generator is a subprocess on its
   * own DB connection (it can only see committed state), so the merge
   * itself cannot share a tx with the build; the consumption markers
   * are the part that must wait for build success, and now they do.
   *
   * Returns `{ staged: { previewUrl, ... } }` so the same toast/iframe-
   * reload pattern as ?/stage works unchanged.
   */
  /**
   * #553 — publish over a FAILED quality check. An explicit human decision
   * with a recorded reason; quality_audits.publish_anyway refuses anything
   * but the current staged build's failed check, records the override and
   * runs the same deploy.promote as Publish live.
   */
  publishAnyway: async ({ request, locals }) => {
    requirePermission(locals, "deploy.trigger");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const r = await execute(registry, adapter, locals.ctx, "quality_audits.publish_anyway", {
      auditRunId: String(form.get("auditRunId") ?? ""),
      reason: String(form.get("reason") ?? ""),
    });
    if (!r.ok) return fail(400, { error: describeError(r.error) });
    return { published: true };
  },
  stageAndDeployStaging: async ({ request, locals }) => {
    requirePermission(locals, "deploy.trigger");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const chatSessionId = String(form.get("chatSessionId") ?? "");
    if (!chatSessionId) return fail(400, { error: "missing chatSessionId" });
    const pageId = String(form.get("pageId") ?? "");

    // The whole flow — #553 classification before the merge, merge
    // (deferConsume), staging build, finalize only on build success, audit
    // enqueue — lives in admin-core's stageChatSessions, shared with the
    // Open changes overview's multi-chat Stage (issue #620).
    const staged = await stageChatSessions({ adapter, registry }, locals.ctx, [chatSessionId]);
    if (!staged.ok) return fail(500, { error: staged.error.message });
    const summary = staged.value;
    const {
      previewUrl,
      previewLabel,
      draftPageCount,
      draftPageTitles,
      unpublishedLinkWarning,
      truncatedListWarning,
      pluginProblemWarning,
    } = await describeStagedBuild(locals.ctx, summary, pageId || null);

    return {
      staged: {
        pageId,
        pageCount: summary.pageCount,
        fileCount: summary.fileCount,
        buildId: summary.buildId,
        previewUrl,
        previewLabel,
        mergedEntityCount: summary.mergedEntityCount,
        draftPageCount,
        draftPageTitles,
        unpublishedLinkWarning,
        truncatedListWarning,
        pluginProblemWarning,
        // Issue #620 — other chats' changes to the same things rode along.
        alsoIncludes: summary.alsoIncludes.map((a) => a.title),
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
   *                   layout + per-placement and content-instance edits
   *                   (the pages each instance renders on, #627)
   *   - "modules"   — module HTML/CSS/JS/fields edits
   *   - "templates" — template body / block layout changes
   *   - "lists"     — shared lists, list types and page types
   *
   * The "lists" kind fans out to a full-site rebuild: a list renders
   * wherever a module binds it or a page query reaches it (per the
   * snapshots.publish_impact_pages fast-path).
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
          contentInstanceIds: string[];
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
            // #627 — "pages" covers per-placement content edits: a content
            // instance re-bakes every page it renders on, through its
            // parents too (a nested-only child has no placement of its own).
            contentInstanceIds: checked.has("pages") ? entities.contentInstanceIds : [],
          },
        );
        changedPageIds = publishChangedPages({
          impact: impactR.ok ? (impactR.value as { pageIds: string[]; fullSite: boolean }) : null,
          pagesChecked: checked.has("pages"),
          editedPageIds: entities.pageIds,
          editedPageLayoutPageIds: entities.pageLayoutPageIds,
        });
      }
    }

    const productionDeploy = await execute(registry, adapter, locals.ctx, "deploy.trigger", {
      targetName: "production",
      ...(changedPageIds && changedPageIds.length > 0 ? { changedPageIds } : {}),
    });
    if (!productionDeploy.ok) {
      // run #10 D6 — stderr breadcrumb on the publish path (same
      // rationale as stageAndDeployStaging/#267): the inline alert and
      // toast show describeError()'s stripped text; the full structured
      // error only survives here.
      console.error("[publishToProduction] deploy.trigger failed", {
        chatSessionId,
        changedPageIds: changedPageIds ?? null,
        error: productionDeploy.error,
      });
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
  /**
   * v0.9.0 — atomic staging → production promote. Replaces the v0.8
   * `?/publishToProduction` re-bake-with-kind-filter path: a Promote is
   * a sync, not a build. `deploy.promote(staging, production)` swaps
   * the production target's symlink (self-hosted) or copies the staging
   * tree (cloud) to point at the last-staged build. Atomic; production
   * gets byte-identical HTML to what the operator reviewed on staging.
   *
   * No per-kind picker — Promote operates on whatever was last Staged.
   * If the operator wants to selectively ship parts, they Stage those
   * parts first, then Promote.
   */
  promoteToProduction: async ({ request, locals }) => {
    requirePermission(locals, "deploy.trigger");
    const { adapter, registry } = getQueryContext();
    const form = await request.formData();
    await assertCsrfToken(form, locals);
    const promote = await execute(registry, adapter, locals.ctx, "deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
    });
    if (!promote.ok) {
      // run #10 D6 — stderr breadcrumb: "Publish live" failures must be
      // forensically visible even when the UI feedback is missed (the
      // layout toast dedups identical consecutive results).
      console.error("[promoteToProduction] deploy.promote failed", { error: promote.error });
      return fail(500, { error: `Publish live failed: ${describeError(promote.error)}` });
    }
    const v = promote.value as { fromRunId: string; toRunId: string; buildId: string };
    return {
      published: {
        targetName: "production",
        fromRunId: v.fromRunId,
        toRunId: v.toRunId,
        buildId: v.buildId,
      },
    };
  },
};
