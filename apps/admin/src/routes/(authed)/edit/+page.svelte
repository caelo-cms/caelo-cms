<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P6.7 — the live-edit surface. Full-bleed iframe of the user's site
   * (rendered branch-aware via /edit/preview/[pageId]?branch=...) with
   * the floating chat overlay on top. Element clicks inside the iframe
   * postMessage chips into the overlay's composer; AI tool results
   * postMessage a reload back to the iframe.
   */

  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import Overlay from "$lib/components/edit/Overlay.svelte";
  import {
    type CaeloMessage,
    isCaeloMessage,
  } from "$lib/components/edit/iframe-protocol.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Combobox } from "$lib/components/ui/combobox/index.js";
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
  // Surfaced from the action result so the overlay can swap into the
  // "Staged — Confirm publish" state. Cleared on a fresh AI tool result.
  const stagedPreviewUrl = $derived(
    form && "staged" in form && form.staged ? (form.staged as { previewUrl?: string }).previewUrl ?? null : null,
  );
  const previewSrc = $derived(
    activePageId
      ? `/edit/preview/${activePageId}?branch=${data.activeChat.chatBranchId}`
      : "",
  );
  let iframe = $state<HTMLIFrameElement | null>(null);
  // Increments on every successful AI tool result; cleared after a successful
  // page switch / publish. Drives the "stay vs publish first" Dialog when the
  // user picks a different page in the Combobox while the chat has
  // unpublished branch snapshots.
  let pendingChanges = $state(0);
  let pendingSwitchTo = $state<string | null>(null);
  let dialogOpen = $state(false);

  /**
   * Page picker change. If the chat has pending branch snapshots, hold the
   * switch in a confirm Dialog; otherwise navigate immediately.
   */
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

  /**
   * iframe → parent: caelo:ready (currently noop), caelo:element-clicked
   * (forward to the overlay's chip composer via window event so the
   * embedded ChatPanel picks it up — the overlay listens for it).
   */
  onMount(() => {
    const handler = (ev: MessageEvent) => {
      if (ev.source !== iframe?.contentWindow) return;
      if (!isCaeloMessage(ev.data)) return;
      const msg = ev.data as CaeloMessage;
      if (msg.kind === "caelo:element-clicked") {
        // Bubble through a CustomEvent the overlay's ChatPanel listens to.
        window.dispatchEvent(
          new CustomEvent("caelo:chip", {
            detail: {
              moduleId: msg.moduleId,
              selector: msg.selector,
              label: msg.label,
            },
          }),
        );
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  });

  /**
   * parent → iframe: caelo:reload after each AI tool result so the
   * iframe re-fetches the branch-aware preview.
   */
  function onAiToolResult(payload: { ok: boolean }): void {
    if (payload.ok) pendingChanges += 1;
    iframe?.contentWindow?.postMessage({ kind: "caelo:reload" }, window.location.origin);
  }
</script>

<div class="relative flex h-[calc(100vh-3.5rem)] w-full">
  <!-- Page-picker strip -->
  <div
    class="absolute left-0 right-[400px] top-0 z-30 flex h-12 items-center gap-3 border-b bg-background/95 px-4 text-sm backdrop-blur"
  >
    <span class="text-muted-foreground">Editing:</span>
    {#if data.pages.length > 0}
      <div class="w-72">
        <Combobox
          items={data.pages.map((p) => ({
            value: p.id,
            label: `${p.slug}  ·  ${p.title}`,
          }))}
          bind:value={activePageId}
          onValueChange={onPageChange}
          placeholder="Pick a page…"
        />
      </div>
    {:else}
      <span class="text-muted-foreground">
        No published pages yet —
        <a class="underline" href="/content/pages">create one</a>.
      </span>
    {/if}
  </div>

  <!-- Iframe -->
  <div class="flex-1 pt-12">
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
        Pick a page to start editing.
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
    {stagedPreviewUrl}
    onToolResult={onAiToolResult}
  />

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
