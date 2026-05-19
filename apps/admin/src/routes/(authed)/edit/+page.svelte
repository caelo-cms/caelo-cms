<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P6.7.2 — chrome-less live-edit. The whole viewport is the iframe of
   * the user's site, with a slim 40 px toolbar at the top (wordmark +
   * URL + page picker + back-to-admin) and the floating chat overlay on
   * top. AppShell sidebar/topbar are absent here (handled by the
   * (authed)/+layout.svelte pathname branch).
   *
   * The iframe loads /edit/preview-by-path/<locale>/<slug> so a relative
   * <a href> inside the iframe naturally navigates within the same
   * preview surface. The injected runtime posts caelo:navigated on
   * every load — the parent updates activePageId/URL/chat-branch
   * context to match.
   *
   * Element-click chips only fire while alt+ctrl+meta are held (see
   * inject-script). Without modifier the iframe behaves like the live
   * site.
   */

  import { enhance } from "$app/forms";
  import { goto, invalidateAll } from "$app/navigation";
  import { ArrowLeft, GitCompareArrows, MousePointerClick } from "lucide-svelte";
  import { onMount } from "svelte";
  import CrossChatBanner from "$lib/components/edit/CrossChatBanner.svelte";
  import DiffPanel from "$lib/components/edit/DiffPanel.svelte";
  import Overlay from "$lib/components/edit/Overlay.svelte";
  import StageDeployButton from "$lib/components/edit/StageDeployButton.svelte";
  import {
    type CaeloMessage,
    isCaeloMessage,
  } from "$lib/components/edit/iframe-protocol.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Combobox } from "$lib/components/ui/combobox/index.js";
  import { cn } from "$lib/utils.js";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog/index.js";

  let { data, form } = $props();
  let activePageId = $state(data.activePageId ?? "");
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
  // back to the active page's locale + slug on first load.
  let displayPath = $state<{ locale: string; slug: string } | null>(null);
  const urlText = $derived.by(() => {
    const cur = displayPath ?? (activePage ? { locale: activePage.locale, slug: activePage.slug } : null);
    if (!cur) return "—";
    return cur.locale === "en" ? `/${cur.slug}` : `/${cur.locale}/${cur.slug}`;
  });

  const stagedPreviewUrl = $derived(
    form && "staged" in form && form.staged
      ? (form.staged as { previewUrl?: string }).previewUrl ?? null
      : null,
  );
  const previewSrc = $derived(
    activePage
      ? `/edit/preview-by-path/${activePage.locale}/${activePage.slug}?branch=${data.activeChat.chatBranchId}`
      : "",
  );
  let iframe = $state<HTMLIFrameElement | null>(null);
  // v0.8.0 — derive directly from server-loaded chat.branch_change_count.
  // The pre-v0.8 path kept a local mutable counter that incremented on
  // every AI tool result (overcounting — tool calls != entity writes,
  // and layout-module edits had no counter delta at all). v0.8 fixes
  // branch_change_count to cover layout-module snapshots; invalidateAll
  // in onAiToolResult re-runs the server load after each tool, so the
  // derived value stays fresh without manual increments.
  const pendingChanges = $derived(data.branchChangeCount ?? 0);
  let pendingSwitchTo = $state<string | null>(null);
  let dialogOpen = $state(false);
  // P6.7.3 — Edit mode toggle. ON: clicks in the iframe become chips.
  // OFF: live-site browsing (links navigate, JS runs).
  let editMode = $state(false);
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

  function setEditMode(on: boolean): void {
    editMode = on;
    iframe?.contentWindow?.postMessage(
      { kind: "caelo:set-edit-mode", on },
      window.location.origin,
    );
  }

  function toggleEditMode(): void {
    setEditMode(!editMode);
  }

  function onPageChange(value: string): void {
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
    const url = new URL(window.location.href);
    url.searchParams.set("page", value);
    void goto(url.toString(), { replaceState: false, noScroll: true, keepFocus: true });
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
    const handler = (ev: MessageEvent) => {
      if (ev.source !== iframe?.contentWindow) return;
      if (!isCaeloMessage(ev.data)) return;
      const msg = ev.data as CaeloMessage;
      if (msg.kind === "caelo:element-clicked") {
        window.dispatchEvent(
          new CustomEvent("caelo:chip", {
            detail: {
              moduleId: msg.moduleId,
              selector: msg.selector,
              label: msg.label,
            },
          }),
        );
      } else if (msg.kind === "caelo:ready") {
        // The iframe finished loading — re-apply edit-mode if it was on
        // before the navigation/reload. The iframe forgets the body
        // class on each load.
        if (editMode) {
          iframe?.contentWindow?.postMessage(
            { kind: "caelo:set-edit-mode", on: true },
            window.location.origin,
          );
        }
      } else if (msg.kind === "caelo:navigated") {
        displayPath = { locale: msg.locale, slug: msg.slug };
        // Click-through navigation inside the iframe — sync activePageId
        // (and the parent URL) so the chat-branch context follows. We
        // skip if the iframe is just confirming the current page on
        // initial load.
        if (msg.pageId !== activePageId) {
          activePageId = msg.pageId;
          const url = new URL(window.location.href);
          url.searchParams.set("page", msg.pageId);
          void goto(url.toString(), {
            replaceState: true,
            noScroll: true,
            keepFocus: true,
          });
        }
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  });

  // v0.9.3 — auto-switch the iframe when the AI creates a new home page
  // mid-chat. The operator-already-on-something path uses a diff
  // against the previously-seen ids so we only switch when a HOME row
  // newly appears (compose_page_from_spec / create_page with slug=home),
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
        const home = data.pages.find((p) => p.slug === "home" && p.locale === "en");
        const pick = home ?? data.pages[0];
        if (pick) activePageId = pick.id;
      }
      seenPageIds = currentIds;
      return;
    }
    const newIds = [...currentIds].filter((id) => !seenPageIds.has(id));
    if (newIds.length === 0) return;
    const newPages = data.pages.filter((p) => newIds.includes(p.id));
    const newHome = newPages.find((p) => p.slug === "home" && p.locale === "en");
    if (newHome) {
      const cur = data.pages.find((p) => p.id === activePageId);
      if (!cur || cur.slug === "home" || activePageId === "") {
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
  function scheduleReload(): void {
    if (reloadTimer !== null) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      iframe?.contentWindow?.postMessage({ kind: "caelo:reload" }, window.location.origin);
    }, 200);
  }

  function onAiToolResult(payload: {
    ok: boolean;
    arguments?: Record<string, unknown>;
  }): void {
    // v0.8.0 — no manual counter increment; pendingChanges is $derived
    // from data.branchChangeCount, which invalidateAll() below refreshes.

    // v0.3.22 — auto-follow the AI's edit target. When a tool's
    // arguments name a different pageId than what's currently
    // shown, switch the iframe to it. Layout / module-only edits
    // omit pageId; we stay on the current page in that case.
    // Stale `data.pages` here is fine — we run invalidateAll() right
    // after, so the next tool-result picks up the fresh list.
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
    void invalidateAll();

    scheduleReload();
  }
</script>

<div class="relative flex h-screen w-full flex-col">
  <!-- v0.8.0 — cross-chat awareness strip. Renders nothing when there
       are no other open chats with pending changes. -->
  <CrossChatBanner chats={data.otherOpenChats ?? []} />

  <!-- Slim toolbar — wordmark + URL + page picker + back-to-admin. No
       sidebar, no breadcrumbs, no admin chrome. -->
  <header
    class="z-30 flex h-11 shrink-0 items-center gap-3 border-b bg-background px-3 text-sm"
    data-testid="edit-toolbar"
  >
    <a
      href="/"
      class="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
      data-testid="back-to-admin"
    >
      <ArrowLeft class="size-4" />
      <span class="font-semibold">Caelo</span>
    </a>
    <span class="text-muted-foreground/50">/</span>
    <code
      class="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground"
      data-testid="edit-url"
    >{urlText}</code>

    <!-- v0.8.0 — Stage / Promote split-button lives in the toolbar
         (per-page surface, per-chat semantics under the hood). The
         (N) badge counts entities on the active chat's branch; the ▾
         opens the Promote-to-production modal. -->
    {#if activePageId && data.activeChat}
      <div class="ml-auto flex items-center gap-3" data-testid="toolbar-publish">
        {#if stagedPreviewUrl}
          <span class="text-xs text-muted-foreground">
            Staged —
            <a
              href={stagedPreviewUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="underline"
            >preview</a>
          </span>
        {/if}
        <StageDeployButton
          pendingChanges={data.pendingChanges}
          branchChangeCount={pendingChanges}
          csrfToken={data.csrfToken}
          chatSessionId={data.activeChat.id}
          sessionPublished={!!data.activeChat.publishedAt}
          {activePageId}
          lastStaged={data.lastStaged ?? null}
        />
      </div>
    {:else}
      <div class="ml-auto"></div>
    {/if}

    <button
      type="button"
      onclick={toggleEditMode}
      data-testid="edit-mode-toggle"
      aria-pressed={editMode}
      class={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
        editMode
          ? "border-blue-500 bg-blue-500 text-white hover:bg-blue-600"
          : "border-border bg-background text-foreground hover:bg-accent",
      )}
      title="When on, clicks in the page select an element to edit"
    >
      <MousePointerClick class="size-3.5" />
      {editMode ? "Editing — click an element" : "Edit elements"}
    </button>
    <button
      type="button"
      onclick={() => (diffOpen = !diffOpen)}
      aria-pressed={diffOpen}
      disabled={!activePage || !data.activeChat}
      class={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors motion-reduce:transition-none",
        diffOpen
          ? "border-blue-500 bg-blue-500 text-white hover:bg-blue-600"
          : "border-border bg-background text-foreground hover:bg-accent",
        (!activePage || !data.activeChat) && "cursor-not-allowed opacity-50",
      )}
      title={!data.activeChat
        ? "Start a chat first to see pending edits"
        : "Side-by-side: main branch vs your pending edits"}
    >
      <GitCompareArrows class="size-3.5" />
      Diff
    </button>
    {#if data.pages.length > 0}
      <div class="w-64">
        <Combobox
          items={data.pages.map((p) => ({
            value: p.id,
            label: `${p.slug}  ·  ${p.title}`,
          }))}
          bind:value={activePageId}
          onValueChange={onPageChange}
          placeholder="Switch page…"
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
          <button
            type="submit"
            title={`Click to switch to ${next}. Drafts stay in live-edit; only published pages ship to Stage / Production.`}
            class={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
              cur === "published"
                ? "border-emerald-500/40 bg-emerald-50 text-emerald-900 hover:bg-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-200"
                : "border-amber-500/40 bg-amber-50 text-amber-900 hover:bg-amber-100 dark:bg-amber-950/30 dark:text-amber-200",
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
    {:else}
      <span class="text-muted-foreground">
        No pages yet —
        <a class="underline" href="/content/pages">create one</a>.
      </span>
    {/if}
  </header>

  <!-- P10 — translation banner. Shown when the active page is a
       non-source variant. Provides a one-click "Bring up to date"
       Mode 2 dispatch when status === 'needs_update'. -->
  {#if data.translationBanner}
    {@const tb = data.translationBanner}
    <div
      class="flex items-center justify-between gap-3 border-b bg-amber-50 px-4 py-2 text-sm dark:bg-amber-950/40"
      data-testid="translation-banner"
    >
      <span>
        {#if tb.status === "needs_update"}
          ⚠ This <code class="font-mono">{tb.targetLocale}</code> translation is out of date. The
          source page changed since this variant was last translated.
        {:else if tb.status === "up_to_date"}
          ✓ This <code class="font-mono">{tb.targetLocale}</code> translation is up to date.
        {:else}
          ○ This <code class="font-mono">{tb.targetLocale}</code> variant has not been translated yet.
        {/if}
      </span>
      {#if tb.status === "needs_update" || tb.status === "not_started"}
        <form method="post" action="/content/translations?/translateOne">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input type="hidden" name="pageId" value={tb.sourcePageId} />
          <input type="hidden" name="targetLocale" value={tb.targetLocale} />
          <input
            type="hidden"
            name="mode"
            value={tb.status === "needs_update" ? "mode_2" : "mode_1"}
          />
          <button
            type="submit"
            class="rounded bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700"
          >
            {tb.status === "needs_update" ? "Bring up to date" : "Translate"}
          </button>
        </form>
      {/if}
    </div>
  {/if}

  <!-- Full-bleed iframe -->
  <div class="flex-1">
    {#if previewSrc}
      <iframe
        bind:this={iframe}
        src={previewSrc}
        title="Live preview"
        sandbox="allow-scripts allow-same-origin"
        class="h-full w-full border-0 bg-white"
        style:pointer-events={overlayDragging ? "none" : "auto"}
      ></iframe>
    {:else}
      <div class="flex h-full items-center justify-center text-muted-foreground">
        No page selected.
      </div>
    {/if}
  </div>

  <!-- Floating overlay -->
  <Overlay
    session={data.activeChat}
    initialMessages={data.messages}
    modules={data.modules}
    csrfToken={data.csrfToken}
    initialLayout={data.layout}
    activePageId={activePageId || null}
    pageChats={data.pageChats}
    globalChats={data.globalChats}
    onToolResult={onAiToolResult}
    onDragStateChange={(active) => (overlayDragging = active)}
  />

  <!-- P6.6b — side-by-side iframe diff. Closes via the X button or
       by toggling the toolbar Diff button. Guarded on activeChat
       too — without a chat session there's no chatBranchId for the
       right pane and the panel would render an empty preview. -->
  {#if activePage && data.activeChat}
    <DiffPanel
      open={diffOpen}
      locale={activePage.locale}
      slug={activePage.slug}
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
