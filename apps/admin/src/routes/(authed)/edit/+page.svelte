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
  import { goto } from "$app/navigation";
  import { ArrowLeft, GitCompareArrows, MousePointerClick } from "lucide-svelte";
  import { onMount } from "svelte";
  import DiffPanel from "$lib/components/edit/DiffPanel.svelte";
  import Overlay from "$lib/components/edit/Overlay.svelte";
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
  let pendingChanges = $state(0);
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
  // Every module on the active page is a candidate for the per-module
  // exclusion list. The diff panel's checkboxes let the user roll back
  // any module's branch overlay to see what the page would look like
  // without that pending edit. A "edited on this branch" filter would
  // be more precise but the chat-runner doesn't surface per-module
  // edit state today — surfacing all modules trusts the user to know
  // which they touched, and is forward-compatible with a stricter
  // filter if one lands.
  const editedModules = $derived(
    (data.modules ?? []).map((m) => ({
      moduleId: m.id,
      label: m.displayName ?? m.slug,
    })),
  );

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
      pendingChanges = 0;
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

  function onAiToolResult(payload: { ok: boolean }): void {
    if (payload.ok) pendingChanges += 1;
    iframe?.contentWindow?.postMessage({ kind: "caelo:reload" }, window.location.origin);
  }
</script>

<div class="relative flex h-screen w-full flex-col">
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

    <!-- P6.7.4 — pending-changes pill + Stage / Confirm publish forms.
         Lives here in the toolbar (not in the chat overlay) so it's
         visible regardless of the chat's pin mode and frees space in
         the chat strip. -->
    {#if activePageId}
      <div class="ml-auto flex items-center gap-2" data-testid="toolbar-publish">
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
          <!-- use:enhance so the form submits via XHR. Without it,
               SvelteKit posts to `/edit?page=X?/confirmPublish` and
               the browser leaves that URL in the address bar — a
               refresh re-fires the action and re-promotes a possibly
               stale staging build. -->
          <form method="post" action="?/confirmPublish" use:enhance>
            <input type="hidden" name="_csrf" value={data.csrfToken} />
            <input type="hidden" name="pageId" value={activePageId} />
            <Button type="submit" size="sm" data-testid="confirm-publish-btn">
              Confirm publish
            </Button>
          </form>
        {:else}
          <span
            class={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium",
              pendingChanges === 0
                ? "bg-muted text-muted-foreground"
                : "bg-amber-500/15 text-amber-700 ring-1 ring-amber-500/40 dark:text-amber-400",
            )}
            data-testid="pending-pill"
          >
            {pendingChanges === 0
              ? "No pending changes"
              : `${pendingChanges} pending change${pendingChanges === 1 ? "" : "s"}`}
          </span>
          <!-- See note on confirmPublish above — use:enhance keeps the
               URL clean so a refresh doesn't re-stage. -->
          <form method="post" action="?/stage" use:enhance>
            <input type="hidden" name="_csrf" value={data.csrfToken} />
            <input type="hidden" name="pageId" value={activePageId} />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={pendingChanges === 0}
              data-testid="stage-btn"
            >Stage</Button>
          </form>
        {/if}
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
      disabled={!activePage}
      class={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors motion-reduce:transition-none",
        diffOpen
          ? "border-blue-500 bg-blue-500 text-white hover:bg-blue-600"
          : "border-border bg-background text-foreground hover:bg-accent",
        !activePage && "cursor-not-allowed opacity-50",
      )}
      title="Side-by-side: main branch vs your pending edits"
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
    {:else}
      <span class="text-muted-foreground">
        No pages yet —
        <a class="underline" href="/content/pages">create one</a>.
      </span>
    {/if}
  </header>

  <!-- Full-bleed iframe -->
  <div class="flex-1">
    {#if previewSrc}
      <iframe
        bind:this={iframe}
        src={previewSrc}
        title="Live preview"
        sandbox="allow-scripts allow-same-origin"
        class="h-full w-full border-0 bg-white"
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
    onToolResult={onAiToolResult}
  />

  <!-- P6.6b — side-by-side iframe diff. Closes via the X button or
       by toggling the toolbar Diff button. -->
  {#if activePage}
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
