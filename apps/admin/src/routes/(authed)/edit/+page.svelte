<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P6.7.2 — chrome-less live-edit. The whole viewport is the iframe of
   * the user's site, with a slim 40 px toolbar at the top (wordmark +
   * URL + page picker + back-to-admin) and the floating chat overlay on
   * top. AppShell sidebar/topbar are absent here (handled by the
   * (authed)/+layout.svelte pathname branch).
   *
   * The iframe loads /edit/preview-by-path/<slug> so a relative
   * <a href> inside the iframe naturally navigates within the same
   * preview surface. The injected runtime posts caelo:navigated on
   * every load — the parent updates activePageId/URL/chat-branch
   * context to match.
   *
   * There is no edit mode: left clicks in the iframe behave like the
   * live site, a right-click or a text selection inside a module offers
   * Ask AI / Add to chat (see inject-script + edit-affordances-script).
   */

  import { type ActionResult, applyAction, deserialize, enhance } from "$app/forms";
  import { goto, refreshAll } from "$app/navigation";
  import { ArrowLeft, Ellipsis, GitCompareArrows } from "lucide-svelte";
  import CaeloMascot from "#lib/components/CaeloMascot.svelte";
  import { onMount } from "svelte";
  import { editorRefreshUrl, unpinChatParam } from "#lib/components/edit/chat-pin.js";
  import CrossChatBanner from "#lib/components/edit/CrossChatBanner.svelte";
  import DiffPanel from "#lib/components/edit/DiffPanel.svelte";
  import PageSearch from "#lib/components/edit/PageSearch.svelte";
  import PageSeoInfo from "#lib/components/edit/PageSeoInfo.svelte";
  import PluginPreview from "#lib/components/edit/PluginPreview.svelte";
  import PluginToolbarSlots from "#lib/components/edit/PluginToolbarSlots.svelte";
  import { localPluginPreview, previewFromResult } from "#lib/components/edit/plugin-preview.js";
  import type { PluginPreviewSelection } from "@caelo-cms/shared";
  import Overlay from "#lib/components/edit/Overlay.svelte";
  import MediaPicker from "#lib/components/MediaPicker.svelte";
  import StageDeployButton from "#lib/components/edit/StageDeployButton.svelte";
  import {
    type FieldEdit,
    type FieldEditMessage,
    type ImageReplaceMessage,
    newPreviewChannel,
    postToPreview,
    previewMessage,
    previewNavigationTarget,
    previewUrl,
    samePreviewDocument,
  } from "#lib/components/edit/iframe-protocol.js";
  import { persistPreviewCookies } from "#lib/components/edit/preview-cookie-jar.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
  } from "#lib/components/ui/dropdown-menu/index.js";
  import { cn } from "#lib/utils.js";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from "#lib/components/ui/dialog/index.js";

  let { data } = $props();
  let activePageId = $state(data.activePageId ?? "");
  let pluginPreviewUrl = $state<string | null>(null);
  let previewSelection = $state<PluginPreviewSelection | null>(null);
  let previewContext = $state<PluginPreviewSelection | null>(null);
  let previewChat = $state("");
  let mounted = $state(false);
  function openPluginPreview(url: string) {
    if (url !== pluginPreviewUrl) { previewSelection = null; previewContext = null; }
    pluginPreviewUrl = url;
    diffOpen = false;
  }
  function closePluginPreview() {
    pluginPreviewUrl = null; previewSelection = null; previewContext = null;
    const url = new URL(location.href); url.searchParams.delete("pluginPreview"); url.searchParams.delete("previewView");
    history.replaceState(history.state, "", url);
  }
  $effect(() => {
    if (!mounted || previewChat === data.activeChat.id) return;
    const first = !previewChat;
    previewChat = data.activeChat.id;
    previewSelection = null;
    const requested = first ? localPluginPreview(new URL(location.href).searchParams.get("pluginPreview"), location.origin) : null;
    pluginPreviewUrl = requested ?? [...data.messages].reverse().filter(m => m.role === "tool").map(m => previewFromResult(m.content, location.origin)).find(Boolean) ?? null;
  });

  /**
   * The 7-day AI spend the runner reported at the end of the most recent turn,
   * in microcents. It is the canonical `ai_calls` total, read back server-side
   * once the turn's row existed — so this is an assignment, never a sum.
   *
   * An earlier revision accumulated per-turn costs on top of the server figure
   * instead. That was wrong twice over: the streamed per-turn number was
   * cache-blind (a turn reading 4.7M cached tokens was priced ~4x its real
   * cost), and adding it to a figure that already contained the same turns
   * double-counted. The readout showed $17 for a session that cost $3.25.
   * Money gets reported, not reconstructed.
   *
   * Null until the first turn completes, when the server-rendered value stands.
   */
  let aiSpendLiveMicrocents = $state<number | null>(null);

  const aiSpendDisplay = $derived.by(() => {
    const microcents = aiSpendLiveMicrocents ?? data.aiSpend7d?.costMicrocents;
    return microcents === undefined || microcents === null
      ? null
      : `$${(microcents / 1e8).toFixed(2)}`;
  });
  // v0.9.4 — true while the Overlay's title-bar drag or any resize
  // handle is mid-gesture. Drives the iframe's pointer-events toggle
  // below so the cursor crossing into the iframe area can't hijack the
  // pointer-up — leaving setPointerCapture stuck and swallowing every
  // subsequent click on the overlay (Resize, Collapse, Send, etc).
  let overlayDragging = $state(false);
  // Active page metadata derived from activePageId — drives URL display.
  const activePage = $derived(data.pages.find((p) => p.id === activePageId) ?? null);
  // The path the iframe is currently showing (covers click-through nav
  // inside the iframe; updated by `caelo:navigated` postMessage). Falls
  // back to the active page's composed path on first load.
  let displayPath = $state<string | null>(null);
  const urlText = $derived.by(() => {
    return displayPath ?? activePage?.currentPath ?? "—";
  });

  // #390 — address the COMPOSED path, matching DiffPanel and the chat
  // panel. The endpoint's slug lookup is a legacy fallback for pre-#390
  // bookmarks; the live surface should hit the primary currentPath
  // branch so a plugin-prefixed page (e.g. `/de/preise`) resolves the
  // same way here as it does everywhere else.
  // #946 — the preview is an opaque-origin sandbox; this editor's random
  // channel is how the two sides recognise each other (iframe-protocol.ts).
  const previewChannel = newPreviewChannel();
  const previewSrc = $derived(
    activePage
      ? previewUrl(activePage.currentPath, {
          channel: previewChannel,
          branch: data.activeChat.chatBranchId,
        })
      : "",
  );
  let iframe = $state<HTMLIFrameElement | null>(null);
  // The iframe's src is set here, not bound in the markup: the editor also
  // navigates the iframe itself (`caelo:navigate`, #946), and once the
  // preview reports the page it landed on, `previewSrc` follows to the same
  // page — that must not load it a second time (losing the link's #anchor).
  $effect(() => {
    const src = previewSrc;
    if (!iframe || !src) return;
    if (!samePreviewDocument(iframe.getAttribute("src"), src, window.location.origin)) {
      iframe.src = src;
    }
  });
  // v0.8.0 — derive directly from server-loaded chat.branch_change_count.
  // The pre-v0.8 path kept a local mutable counter that incremented on
  // every AI tool result (overcounting — tool calls != entity writes,
  // and layout-module edits had no counter delta at all). v0.8 fixes
  // branch_change_count to cover layout-module snapshots; refreshAll
  // in onAiToolResult re-runs the server load after each tool, so the
  // derived value stays fresh without manual increments.
  const pendingChanges = $derived(data.branchChangeCount ?? 0);
  let pendingSwitchTo = $state<string | null>(null);
  let dialogOpen = $state(false);
  // Height of the page chrome above the preview (cross-chat banner +
  // toolbar); the pinned-right overlay is placed below it.
  let bannerHeight = $state(0);
  let toolbarHeight = $state(44);
  // P6.6b — side-by-side diff overlay toggle. The panel reads
  // `editedModules` from the page data and renders main-vs-branch
  // iframes; unchecking a module rolls back its branch overlay on
  // the right via the preview op's `excludeBranchModules`.
  let diffOpen = $state(false);
  // P6.6 polish — modules that actually have a branch snapshot for
  // this chat's branch (i.e. the AI has edited them at least once).
  // Backed by `chat.branch_edited_modules`; falls back to every
  // module on the page if the server load returned an empty list
  // (e.g. brand-new chat with zero edits → nothing to filter).
  const editedModules = $derived.by(() => {
    const ids = (data.branchEditedModuleIds ?? []) as string[];
    const all = (data.modules ?? []).map((m) => ({
      moduleId: m.id,
      label: m.displayName ?? m.slug,
    }));
    if (ids.length === 0) return all;
    const editedSet = new Set(ids);
    return all.filter((m) => editedSet.has(m.moduleId));
  });

  function onPageChange(value: string): void {
    if (pluginPreviewUrl) closePluginPreview();
    if (value === activePageId) return;
    if (pendingChanges > 0) {
      pendingSwitchTo = value;
      dialogOpen = true;
      return;
    }
    commitPageSwitch(value);
  }

  function commitPageSwitch(value: string): void {
    activePageId = value;
    const url = pageSwitchUrl();
    url.searchParams.set("page", value);
    void goto(url.toString(), { reset: false });
  }

  function dialogStay(): void {
    dialogOpen = false;
    pendingSwitchTo = null;
  }

  function dialogDiscard(): void {
    if (pendingSwitchTo) {
      // v0.8.0 — pendingChanges is $derived from data.branchChangeCount,
      // so no manual reset needed; the goto below re-runs the server
      // load against the destination page's chat.
      commitPageSwitch(pendingSwitchTo);
    }
    dialogOpen = false;
    pendingSwitchTo = null;
  }

  onMount(() => {
    mounted = true;
    const openLink = (event: MouseEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.closest('[data-testid="plugin-live-preview"]')) return;
      const url = localPluginPreview(anchor.href, location.origin);
      if (!url) return;
      event.preventDefault(); openPluginPreview(url);
    };
    document.addEventListener("click", openLink, true);
    const handler = (ev: MessageEvent) => {
      // The preview window, opaque origin AND this editor's channel: an
      // external page the preview navigated to must not drive saves (see
      // previewMessage).
      const msg = previewMessage(ev, iframe?.contentWindow, previewChannel);
      if (!msg) return;
      if (msg.kind === "caelo:element-referenced") {
        // Chip (+ Ask AI composer focus) for the chat; the Overlay expands itself
        // first when collapsed so ChatPanel is mounted to receive it.
        const { kind: _kind, ...detail } = msg;
        window.dispatchEvent(new CustomEvent("caelo:chip", { detail }));
      } else if (msg.kind === "caelo:field-edit") {
        void saveFields(msg);
      } else if (msg.kind === "caelo:image-replace") {
        imageReplace = msg;
        imagePickerOpen = true;
      } else if (msg.kind === "caelo:ready") {
        // #965 — the document the post-save reload asked for has rendered.
        if (awaitingRender !== null) {
          renderedSave = awaitingRender;
          awaitingRender = null;
        }
        // Link-target suggestions for the preview's link editor (#918).
        postToPreview(iframe?.contentWindow, {
          kind: "caelo:page-paths",
          pages: data.pages.map((p) => ({ path: p.currentPath, title: p.title })),
        });
      } else if (msg.kind === "caelo:cookies") {
        // The sandboxed preview cannot store cookies; the editor keeps
        // them so a consent decision survives the next load.
        persistPreviewCookies(msg.cookies);
      } else if (msg.kind === "caelo:navigate") {
        // #946 — the sandboxed preview cannot navigate itself (its own
        // navigations carry no session); the editor does, after checking
        // the target is a preview page. Always a fresh load (a reload too).
        const target = previewNavigationTarget(msg.href, previewChannel, window.location.origin);
        if (target && iframe) iframe.src = target;
      } else if (msg.kind === "caelo:navigated") {
        displayPath = msg.path || null;
        // Click-through navigation inside the iframe — sync activePageId
        // (and the parent URL) so the chat-branch context follows. We
        // skip if the iframe is just confirming the current page on
        // initial load.
        if (msg.pageId !== activePageId) {
          activePageId = msg.pageId;
          const url = pageSwitchUrl();
          url.searchParams.set("page", msg.pageId);
          void goto(url.toString(), { replace: true, reset: false });
        }
      }
    };
    window.addEventListener("message", handler);
    return () => { window.removeEventListener("message", handler); document.removeEventListener("click", openLink, true); };
  });

  // v0.9.3 — auto-switch the iframe when the AI creates a new home page
  // mid-chat. The operator-already-on-something path uses a diff
  // against the previously-seen ids so we only switch when a HOME row
  // newly appears (build_page with slug=home),
  // never on every load. Operators who deliberately picked a non-home
  // page keep that selection unless their pick was itself a previous
  // home — that's the build-from-scratch flow taking over.
  //
  // v0.9.5 — `initialized` flag instead of `seenPageIds.size === 0` as
  // the init gate. Without it, an empty `data.pages` on mount (fresh
  // install before any AI activity) loops the effect forever: each run
  // writes a NEW empty Set to seenPageIds, the size === 0 invariant
  // stays true, Svelte triggers another run, infinite update depth.
  let initialized = $state(false);
  let seenPageIds = $state(new Set<string>());
  $effect(() => {
    const currentIds = new Set(data.pages.map((p) => p.id));
    if (!initialized) {
      initialized = true;
      // Fresh-install "no active page yet" — pick the home (or first)
      // so the iframe gets a src instead of staying blank.
      if (activePageId === "" && data.pages.length > 0) {
        const home = data.pages.find((p) => p.currentPath === "/");
        const pick = home ?? data.pages[0];
        if (pick) activePageId = pick.id;
      }
      seenPageIds = currentIds;
      return;
    }
    const newIds = [...currentIds].filter((id) => !seenPageIds.has(id));
    if (newIds.length === 0) return;
    const newPages = data.pages.filter((p) => newIds.includes(p.id));
    const newHome = newPages.find((p) => p.currentPath === "/");
    if (newHome) {
      const cur = data.pages.find((p) => p.id === activePageId);
      if (!cur || cur.currentPath === "/" || activePageId === "") {
        activePageId = newHome.id;
      }
    }
    seenPageIds = currentIds;
  });

  // v0.3.22 — debounce rapid iframe reloads. Bulk tool variants
  // (*.create_many) and back-to-back module writes fire multiple
  // `tool-result` events within <1s. Without debouncing each one
  // triggers a fresh page load, mid-fetch reloads may be dropped,
  // and the user sees flicker without convergence. 200ms trailing
  // edge collapses bursts into one final reload showing the
  // post-burst state.
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  // #965 — which in-place save the preview shows. `saveSeq` counts saves;
  // the reload scheduled after save n carries n (`reloadFor`), becomes
  // `awaitingRender` when it is posted, and the next `caelo:ready` from the
  // reloaded document moves it to `renderedSave`, exposed on the iframe as
  // `data-caelo-rendered-save`. That is the "the stored text is on screen"
  // signal; the saving marker alone also vanishes on any other reload.
  let saveSeq = 0;
  let reloadFor: number | null = null;
  let awaitingRender: number | null = null;
  let renderedSave = $state(0);
  function scheduleReload(forSave?: number): void {
    if (forSave !== undefined) reloadFor = forSave;
    if (reloadTimer !== null) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (reloadFor !== null) {
        awaitingRender = reloadFor;
        reloadFor = null;
      }
      postToPreview(iframe?.contentWindow, { kind: "caelo:reload" });
    }, 200);
  }

  /**
   * #965 — re-run the server load without letting it pick another chat
   * (`chat-pin.ts` says why). The id is the chat this editor wrote into
   * `?chat=`, so a page switch drops only that, never a chat the operator
   * picked in the overlay since. `?page=` follows the page the preview
   * shows (#1156): an AI tool result can switch it on the client, and the
   * load's page-bound data (its SEO info) must follow.
   */
  let pinnedChatId: string | null = null;
  function refreshPinned(): Promise<void> {
    const r = editorRefreshUrl(window.location.href, data.activeChat.id, activePageId || null);
    if (!r.changed) return refreshAll();
    if (r.pinned) pinnedChatId = data.activeChat.id;
    return goto(r.url.toString(), { replace: true, reset: false, refreshAll: true });
  }

  /** The editor's URL for a page switch: without the chat this editor pinned. */
  function pageSwitchUrl(): URL {
    const url = new URL(window.location.href);
    unpinChatParam(url, pinnedChatId);
    pinnedChatId = null;
    return url;
  }

  /**
   * #917 / #918 — save in-place edits from the preview through the
   * `editFields` action on this chat's branch, then reload the preview; it
   * shows the stored values either way (the new ones, or the old ones when
   * the save was refused). `applyAction` hands the outcome to the layout's
   * toast effect like any form action.
   */
  async function saveFields(msg: Omit<FieldEditMessage, "kind">): Promise<void> {
    const body = new FormData();
    body.set("_csrf", data.csrfToken);
    body.set("chatSessionId", data.activeChat.id);
    body.set("chatBranchId", data.activeChat.chatBranchId);
    body.set("pageId", msg.pageId);
    body.set("blockName", msg.blockName);
    body.set("position", String(msg.position));
    body.set("edits", JSON.stringify(msg.edits));
    if (msg.scope) body.set("scope", msg.scope);
    try {
      const res = await fetch("?/editFields", {
        method: "POST",
        body,
        headers: { "x-sveltekit-action": "true" },
      });
      const result: ActionResult = deserialize(await res.text());
      // An unexpected server error would otherwise replace the editor
      // with the error page; report it like a refused save instead.
      const outcome: ActionResult =
        result.type === "error"
          ? {
              type: "failure",
              status: 500,
              data: { error: "Not saved: the server failed." },
              location: result.location ?? `${location.pathname}${location.search}`,
            }
          : result;
      await applyAction(outcome);
    } finally {
      // The chat stays pinned through the refresh, and the reload is only
      // scheduled once the refreshed data (same chat, same branch) is in,
      // so it renders exactly the branch the save wrote to (#965).
      const seq = ++saveSeq;
      await refreshPinned().catch((e: unknown) => console.error("[edit] refresh failed", e));
      scheduleReload(seq);
    }
  }

  // #918 — "Replace image…" in the preview: the picked image goes into the
  // marked `src` field, its alt text into the marked `alt` field (if any).
  let imageReplace = $state<ImageReplaceMessage | null>(null);
  let imagePickerOpen = $state(false);
  function onImagePicked(m: { url: string; alt: string }): void {
    const req = imageReplace;
    imageReplace = null;
    if (!req) return;
    const edits: FieldEdit[] = [{ ...req.src, text: m.url }];
    if (req.alt && m.alt.trim().length > 0) edits.push({ ...req.alt, text: m.alt });
    void saveFields({
      pageId: req.pageId,
      blockName: req.blockName,
      position: req.position,
      edits,
      ...(req.scope ? { scope: req.scope } : {}),
    });
  }

  function onAiToolResult(payload: {
    ok: boolean;
    content?: string;
    arguments?: Record<string, unknown>;
  }): void {
    // v0.8.0 — no manual counter increment; pendingChanges is $derived
    // from data.branchChangeCount, which refreshAll() below refreshes.

    // v0.3.22 — auto-follow the AI's edit target. When a tool's
    // arguments name a different pageId than what's currently
    // shown, switch the iframe to it. Layout / module-only edits
    // omit pageId; we stay on the current page in that case.
    // Stale `data.pages` here is fine — we run refreshAll() right
    // after, so the next tool-result picks up the fresh list.
    if (payload.ok && payload.content) {
      const next = previewFromResult(payload.content, location.origin);
      if (next) openPluginPreview(next);
    }
    const args = payload.arguments;
    const targetPageId =
      args && typeof args["pageId"] === "string" ? (args["pageId"] as string) : null;
    if (targetPageId && targetPageId !== activePageId) {
      const matched = data.pages.find((p) => p.id === targetPageId);
      if (matched) activePageId = matched.id;
    }

    // v0.3.22 — refresh server-loaded `data.pages` etc. so newly-
    // created pages / layouts surface in the page picker + activate
    // automatically on fresh installs. Without this, `activePage`
    // stays null and the iframe shows nothing while the AI builds.
    void refreshPinned();

    scheduleReload();
  }
</script>

<div class="relative flex h-screen w-full flex-col">
  <!-- v0.8.0 — cross-chat awareness strip. Renders nothing when there
       are no other open chats with pending changes. -->
  <!-- Measured with the toolbar below: the pinned-right chat column starts
       under both, so the banner never pushes toolbar controls beneath it. -->
  <div class="shrink-0" bind:clientHeight={bannerHeight}>
    <CrossChatBanner chats={data.otherOpenChats ?? []} />
    {#if data.chatNotice}
      <!-- #1102 — the URL's chat could not be opened; never switch silently. -->
      <div
        class="z-30 flex min-h-9 shrink-0 items-center gap-2 border-b bg-amber-500/10 px-3 py-1 text-xs text-amber-900 dark:text-amber-200"
        role="note"
        data-testid="chat-notice"
      >
        <span>{data.chatNotice}</span>
        <a
          href={`/edit?${data.activePageId ? `page=${data.activePageId}&` : ""}chat=${data.activeChat.id}`}
          class="shrink-0 underline underline-offset-2"
          data-testid="chat-notice-continue">Continue here</a
        >
      </div>
    {/if}
  </div>

  <!-- The toolbar, in three groups: the page (an address bar with the SEO
       info, the page picker and its status, then the plugin places next to
       it), the chat's work (Diff), and getting it out (Staging, Publish
       live). Nothing in it covers the preview; only the chat does. On
       phones it wraps: the address bar takes its own row and the
       desktop-only controls step aside; the chat overlay starts below
       whatever height it measures (toolbarHeight). -->
  <header
    class="z-30 flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b bg-background px-3 py-1.5 text-sm"
    data-testid="edit-toolbar"
    bind:clientHeight={toolbarHeight}
  >
    <a
      href="/"
      class="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
      data-testid="back-to-admin"
    >
      <ArrowLeft class="size-4" />
      <span class="font-semibold">Caelo</span>
    </a>
    <span class="mx-1 hidden h-5 w-px bg-border sm:inline-block" aria-hidden="true"></span>

    {#if pluginPreviewUrl}
      <code class="rounded bg-muted px-1.5 py-0.5 text-xs" data-testid="edit-url">Preview</code>
      <button type="button" class="underline" onclick={closePluginPreview}>Website preview</button>
    {:else if data.pages.length > 0}
      <!-- The page address: what the browser's address bar is to a site.
           The SEO info sits where a browser shows the site info. -->
      <div
        class="order-last flex h-9 w-full min-w-0 items-center gap-1 rounded-lg border bg-muted/40 pl-1 pr-1.5 focus-within:border-ring sm:order-none sm:w-[30rem]"
        data-testid="edit-address"
      >
        {#if previewSrc && data.pageSeo && data.activePageId === activePageId}
          <!-- Only while the loaded SEO is the shown page's: a client-side page
               switch hides it until the refresh (?page= follows) brings that page's. -->
          <PageSeoInfo info={data.pageSeo} path={urlText} siteUrl={data.live.siteUrl} />
        {/if}
        <code
          class="hidden max-w-[12rem] shrink-0 truncate font-mono text-xs text-foreground sm:inline"
          data-testid="edit-url"
        >{urlText}</code>
        <div class="flex min-w-0 flex-1" data-testid="edit-page-picker">
          <PageSearch
            pages={data.pages}
            recent={data.recentPages}
            currentPageId={activePageId}
            onPick={onPageChange}
          />
        </div>
        <!-- v0.9.9 — per-page status toggle. Drafts are LIVE-EDIT ONLY
             (visible in iframe + picker); Stage and Production filter to
             `status='published'`. Click to flip the active page's
             status. Form action rides the chat branch so the flip
             merges to main at Stage like any other edit. -->
        {#if activePage}
          {@const cur = activePage.status}
          {@const next = cur === "published" ? "draft" : "published"}
          <form
            method="post"
            action="?/setPageStatus"
            use:enhance={() => async ({ update }) => {
              await update({ reset: false });
            }}
            data-testid="page-status-toggle"
          >
            <input type="hidden" name="_csrf" value={data.csrfToken} />
            <input type="hidden" name="pageId" value={activePage.id} />
            <input type="hidden" name="status" value={next} />
            <input type="hidden" name="chatSessionId" value={data.activeChat.id} />
            <input type="hidden" name="chatBranchId" value={data.activeChat.chatBranchId} />
            <button
              type="submit"
              title={`Click to switch to ${next}. Drafts stay in live-edit; only published pages ship to Stage / Production.`}
              class={cn(
                "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors",
                cur === "published"
                  ? "bg-emerald-50 text-emerald-900 hover:bg-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-200"
                  : "bg-amber-50 text-amber-900 hover:bg-amber-100 dark:bg-amber-950/30 dark:text-amber-200",
              )}
            >
              <span
                class={cn(
                  "size-2 rounded-full",
                  cur === "published" ? "bg-emerald-500" : "bg-amber-500",
                )}
              ></span>
              {cur === "published" ? "Published" : "Draft"}
            </button>
          </form>
        {/if}
      </div>
      <!-- Plugin places (the SDK's editorToolbar), streamed: a slow plugin
           never holds up the editor. Shown only for the page they describe. -->
      {#await data.pluginToolbar then slots}
        {#if data.activePageId === activePageId}
          <PluginToolbarSlots
            {slots}
            path={urlText}
            pageIds={new Set(data.pages.map((p) => p.id))}
            onOpenPage={onPageChange}
          />
        {/if}
      {:catch e}
        <span
          role="alert"
          class="max-w-60 truncate text-xs font-medium text-red-700 dark:text-red-300"
          title={e instanceof Error ? e.message : String(e)}
          data-testid="plugin-toolbar-error"
        >
          Plugin toolbar failed: {e instanceof Error ? e.message : String(e)}
        </span>
      {/await}
    {:else}
      <span class="text-muted-foreground">
        No pages yet —
        <a class="underline" href="/content/pages">create one</a>.
      </span>
    {/if}

    <div class="ml-auto"></div>

    <button
      type="button"
      onclick={() => (diffOpen = !diffOpen)}
      aria-pressed={diffOpen}
      disabled={!!pluginPreviewUrl || !activePage || !data.activeChat}
      class={cn(
        "hidden h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors motion-reduce:transition-none md:inline-flex",
        diffOpen
          ? "border-link bg-link/10 text-link hover:bg-link/15"
          : "border-border bg-background text-foreground hover:bg-accent",
        (!activePage || !data.activeChat) && "cursor-not-allowed opacity-50",
      )}
      title={!data.activeChat
        ? "Start a chat first to see pending edits"
        : pendingChanges > 0
          ? `${pendingChanges} ${pendingChanges === 1 ? "change" : "changes"} in this chat, side by side with the live version`
          : "No changes in this chat yet"}
      data-testid="diff-toggle"
    >
      <GitCompareArrows class="size-3.5" />
      Diff <span class="tabular-nums text-muted-foreground">({pendingChanges})</span>
    </button>

    {#if !pluginPreviewUrl && activePageId && data.activeChat}
      <div class="flex items-center gap-2" data-testid="toolbar-publish">
        <StageDeployButton
          pendingChanges={data.pendingChanges}
          branchChangeCount={pendingChanges}
          csrfToken={data.csrfToken}
          chatSessionId={data.activeChat.id}
          sessionPublished={!!data.activeChat.publishedAt}
          sessionLastStagedAt={data.activeChat.lastStagedAt ?? null}
          {activePageId}
          lastStaged={data.lastStaged ?? null}
          lastPublishedLive={data.lastPublishedLive ?? null}
          productionMatchesStaging={data.productionMatchesStaging ?? null}
          lastStageFailure={data.lastStageFailure ?? null}
          live={data.live}
        />
      </div>
    {/if}

    <DropdownMenu>
      <DropdownMenuTrigger
        class="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="More"
        title="More"
        data-testid="edit-more"
      >
        <Ellipsis class="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-64">
        {#if aiSpendDisplay}
          <div class="flex items-center justify-between px-2 py-1.5 text-sm" data-testid="edit-ai-spend">
            <span>AI spend</span>
            <span class="tabular-nums text-muted-foreground">{aiSpendDisplay} · 7 days</span>
          </div>
          <DropdownMenuSeparator />
        {/if}
        <DropdownMenuItem onSelect={() => void goto("/")}>Back to the admin</DropdownMenuItem>
        {#if activePageId}
          <DropdownMenuItem onSelect={() => void goto(`/content/pages/${activePageId}`)}>
            Page settings
          </DropdownMenuItem>
        {/if}
      </DropdownMenuContent>
    </DropdownMenu>
  </header>

  <div class={pluginPreviewUrl ? "flex min-h-0 flex-1 flex-col md:flex-row" : "contents"}>
  <!-- Full-bleed iframe -->
  <div class="relative min-h-0 flex-1">
    {#if pluginPreviewUrl}
      <PluginPreview url={pluginPreviewUrl} chatSessionId={data.activeChat.id} onSelection={(selection) => { previewSelection = selection; }} onContext={(context) => { previewContext = context; }} onDocument={openPluginPreview} />
    {:else if previewSrc}
      <iframe
        bind:this={iframe}
        title="Live preview"
        data-caelo-live-preview
        data-caelo-rendered-save={renderedSave}
        sandbox="allow-scripts"
        class="h-full w-full border-0 bg-white"
        style:pointer-events={overlayDragging ? "none" : "auto"}
      ></iframe>
    {:else}
      <!-- Operator feedback (2026-07-12): a bare "No page selected."
           on an empty install reads as a dead end. The canvas points
           at the chat — the chat IS the product (CLAUDE.md 1A). -->
      <!-- The stage: Caelo's mascot above a page sketch that draws in
           once and comes to rest — the calm spot where the first page
           will materialize. Operator-requested warmth, not tech. -->
      <div class="flex h-full flex-col items-center justify-center gap-6 px-6">
        <CaeloMascot size={130} />
        <div class="caelo-stage w-full max-w-xs space-y-2.5 opacity-60">
          <div class="h-16 rounded-lg border-2 border-dashed border-muted-foreground/35"></div>
          <div class="h-2.5 w-3/4 rounded border-2 border-dashed border-muted-foreground/25"></div>
          <div class="h-2.5 w-1/2 rounded border-2 border-dashed border-muted-foreground/25"></div>
          <div class="grid grid-cols-3 gap-2.5">
            <div class="h-10 rounded-md border-2 border-dashed border-muted-foreground/20"></div>
            <div class="h-10 rounded-md border-2 border-dashed border-muted-foreground/20"></div>
            <div class="h-10 rounded-md border-2 border-dashed border-muted-foreground/20"></div>
          </div>
        </div>
        <div class="space-y-2 text-center">
          <p class="text-lg font-semibold">Chat and build your page</p>
          <p class="text-sm text-muted-foreground">
            {data.pages.length === 0
              ? "Describe what you want in the chat — your page appears right here."
              : "Tell the chat which page to open — or pick one in the top bar."}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onclick={() => window.dispatchEvent(new CustomEvent("caelo:focus-chat"))}
        >
          Write your first prompt
        </Button>
      </div>
    {/if}
  </div>

  <!-- Dock beside plugin documents so the chat never covers the selected page. -->
  <div class={pluginPreviewUrl ? "h-[45vh] shrink-0 md:h-full md:w-[420px]" : "contents"}>
  <!-- #918 — "Replace image…" from the preview's right-click menu. -->
<MediaPicker
  bind:open={imagePickerOpen}
  onClose={() => (imageReplace = null)}
  onPick={onImagePicked}
/>

<Overlay
    docked={!!pluginPreviewUrl}
    chromeBottom={bannerHeight + toolbarHeight}
    previewSelection={previewSelection ?? previewContext}
    onClearPreviewSelection={previewSelection ? () => { previewSelection = null; } : undefined}
    session={data.activeChat}
    initialMessages={data.messages}
    initialHasMore={data.hasMoreMessages}
    firstRunSuggestions={data.firstRunSuggestions}
    modules={data.modules}
    csrfToken={data.csrfToken}
    initialLayout={data.layout}
    activePageId={pluginPreviewUrl ? null : activePageId || null}
    pageChats={data.pageChats}
    globalChats={data.globalChats}
    agentChatGroups={data.agentChatGroups}
    onToolResult={onAiToolResult}
    onSpendUpdate={(microcents) => {
      aiSpendLiveMicrocents = microcents;
    }}
    onDragStateChange={(active) => (overlayDragging = active)}
  />

  </div>
  </div>
  <!-- P6.6b — side-by-side iframe diff. Closes via the X button or
       by toggling the toolbar Diff button. Guarded on activeChat
       too — without a chat session there's no chatBranchId for the
       right pane and the panel would render an empty preview. -->
  {#if activePage && data.activeChat}
    <DiffPanel
      open={diffOpen}
      path={activePage.currentPath}
      chatBranchId={data.activeChat.chatBranchId}
      editedModules={editedModules}
      onclose={() => (diffOpen = false)}
    />
  {/if}

  <!-- Page-switch with pending changes confirm Dialog -->
  <Dialog bind:open={dialogOpen}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Pending changes on this chat</DialogTitle>
        <DialogDescription>
          You have {pendingChanges} pending change{pendingChanges === 1 ? "" : "s"}
          on the current chat branch. Switching pages won't lose them — they'll
          stay on this chat — but you'll need to come back to publish.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button type="button" variant="outline" onclick={dialogStay}>
          Stay on this page
        </Button>
        <Button type="button" onclick={dialogDiscard}>
          Switch anyway
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</div>

<style>
  /* One-time draw-in of the page sketch under the mascot (top-down,
     staggered), then everything rests. One-off CSS animation per
     CLAUDE.md 6A; reduced-motion users get the static sketch. */
  .caelo-stage > :global(*) {
    animation: caelo-stage-sketch 0.7s ease-out both;
  }
  .caelo-stage > :global(*:nth-child(2)) {
    animation-delay: 0.25s;
  }
  .caelo-stage > :global(*:nth-child(3)) {
    animation-delay: 0.45s;
  }
  .caelo-stage > :global(*:nth-child(4)) {
    animation-delay: 0.65s;
  }
  @keyframes caelo-stage-sketch {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .caelo-stage > :global(*) {
      animation: none;
    }
  }
</style>
