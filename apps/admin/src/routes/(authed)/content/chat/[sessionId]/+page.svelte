<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Eye, EyeOff } from "lucide-svelte";
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import ChatPanel from "$lib/components/chat/ChatPanel.svelte";

  let { data, form } = $props();

  // v0.2.46 — debug panel toggle. Reactive so toggling ?debug=1 in
  // the URL flips it without reload. Permission gate happens in the
  // server load (data.canDebug); this just consumes the flag.
  // v0.2.55 — also toggleable via a button inside ChatPanel. The
  // button calls toggleDebug which flips the URL param so the state
  // survives reload + can be shared as a deep link.
  let debugFlag = $state(page.url.searchParams.get("debug") === "1");
  const debug = $derived(debugFlag && data.canDebug === true);

  function toggleDebug(): void {
    debugFlag = !debugFlag;
    const url = new URL(window.location.href);
    if (debugFlag) url.searchParams.set("debug", "1");
    else url.searchParams.delete("debug");
    window.history.replaceState({}, "", url.toString());
  }

  // P8 review-pass: the SEO panel's Autofill / Re-optimize buttons
  // create a chat with `?prompt=<text>`. ChatPanel already listens
  // for the `caelo:insert-into-composer` CustomEvent (P7 wiring for
  // the /edit MediaPicker), so we re-use it here. Fire once on mount
  // and clear the URL param so a rerender doesn't replay.
  onMount(() => {
    const prompt = page.url.searchParams.get("prompt");
    if (prompt && prompt.length > 0) {
      document.dispatchEvent(
        new CustomEvent("caelo:insert-into-composer", { detail: { text: prompt } }),
      );
      const next = new URL(window.location.href);
      next.searchParams.delete("prompt");
      window.history.replaceState({}, "", next.toString());
    }
  });

  // v0.3.21 — live-preview pane. Mirrors /edit's iframe-postMessage
  // protocol so the user can watch the AI build pages in real time
  // without leaving the chat surface. Defaults to OPEN when the
  // install has at least one page; collapsed otherwise (fresh
  // install — AI is about to create the first page). User toggle
  // persists in localStorage so the choice survives reloads.
  const previewKey = "caelo:chat-preview-open";
  let previewOpen = $state(false);
  let iframe = $state<HTMLIFrameElement | null>(null);

  onMount(() => {
    const stored = localStorage.getItem(previewKey);
    if (stored === "0") previewOpen = false;
    else if (stored === "1") previewOpen = true;
    else previewOpen = data.previewDefault !== null;
  });

  function togglePreview(): void {
    previewOpen = !previewOpen;
    localStorage.setItem(previewKey, previewOpen ? "1" : "0");
  }

  const previewSrc = $derived(
    data.previewDefault
      ? `/edit/preview-by-path/${data.previewDefault.locale}/${data.previewDefault.slug}?branch=${data.session.chatBranchId}`
      : null,
  );

  // Reload the iframe on every successful AI tool-result so the user
  // sees mutations land in real time. Same protocol as /edit's
  // onAiToolResult — iframe-inject-script listens for caelo:reload.
  function onAiToolResult(payload: { ok: boolean }): void {
    if (!payload.ok || !iframe?.contentWindow) return;
    iframe.contentWindow.postMessage({ kind: "caelo:reload" }, window.location.origin);
  }
</script>

<div class="flex h-screen">
  {#if previewOpen && previewSrc}
    <div class="flex-1 border-r bg-background relative">
      <iframe
        bind:this={iframe}
        src={previewSrc}
        title="Live preview"
        class="h-full w-full border-0"
      ></iframe>
      <button
        type="button"
        onclick={togglePreview}
        class="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-background/90 px-2 py-1 text-xs shadow ring-1 ring-border hover:bg-accent"
        aria-label="Hide live preview"
      >
        <EyeOff class="size-3" />
        Hide preview
      </button>
    </div>
  {/if}

  <div class="flex {previewOpen && previewSrc ? 'w-[480px]' : 'flex-1'} flex-col">
    {#if !previewOpen}
      <div class="border-b px-3 py-1.5 flex items-center justify-end">
        <button
          type="button"
          onclick={togglePreview}
          class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs ring-1 ring-border hover:bg-accent"
          aria-label="Show live preview"
        >
          <Eye class="size-3" />
          {data.previewDefault ? "Show live preview" : "Preview (no pages yet)"}
        </button>
      </div>
    {/if}

    <div class="flex-1 overflow-hidden">
      <ChatPanel
        session={data.session}
        initialMessages={data.messages}
        modules={data.modules}
        csrfToken={data.csrfToken}
        formError={form?.error ?? null}
        pendingChanges={data.pendingChanges}
        {debug}
        canDebug={data.canDebug}
        onToggleDebug={toggleDebug}
        onToolResult={onAiToolResult}
      />
    </div>
  </div>
</div>
