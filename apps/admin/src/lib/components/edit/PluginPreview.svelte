<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { onMount } from "svelte";
  import { pluginPreviewDocumentSchema, type PluginPreviewSelection } from "@caelo-cms/shared";
  let { url, onSelection }: { url: string; onSelection: (selection: PluginPreviewSelection | null) => void } = $props();
  let view = $state("");
  let metadata = $state<ReturnType<typeof pluginPreviewDocumentSchema.parse> | null>(null);
  let src = $state("");
  let channel = $state("");
  let failure = $state("");
  let iframe = $state<HTMLIFrameElement | null>(null);
  let selectedId = $state("");
  let ready = $state(false);
  let baseUrl = "";
  let baseDoc: ReturnType<typeof pluginPreviewDocumentSchema.parse> | null = null;
  const pluginSlug = $derived(url.split("/")[2] ?? "");
  function select(id: string) {
    const target = metadata?.targets.find((item) => item.id === id);
    if (!target) return;
    selectedId = id;
    onSelection({ ...target, pluginSlug });
  }
  onMount(() => {
    view = new URL(location.href).searchParams.get("previewView") ?? "";
    ready = true;
    const handle = (event: MessageEvent) => {
      if (event.source !== iframe?.contentWindow || event.data?.kind !== "caelo:plugin-target" || event.data?.channel !== channel || typeof event.data?.id !== "string") return;
      select(event.data.id);
    };
    window.addEventListener("message", handle);
    return () => { window.removeEventListener("message", handle); onSelection(null); };
  });
  $effect(() => {
    if (!ready) return;
    const currentUrl = url, currentView = view;
    const controller = new AbortController();
    metadata = null; src = ""; failure = ""; onSelection(null);
    async function load() {
      try {
        const endpoint = new URL(currentUrl, location.origin);
        endpoint.searchParams.set("format", "metadata");
        if (baseUrl !== currentUrl || !baseDoc) {
          const initialResponse = await fetch(endpoint, { signal: controller.signal });
          if (!initialResponse.ok) throw new Error(`Preview unavailable (${initialResponse.status})`);
          baseDoc = pluginPreviewDocumentSchema.parse({ ...await initialResponse.json(), html: "" });
          baseUrl = currentUrl;
        }
        const validView = baseDoc.views.some((item) => item.id === currentView) ? currentView : baseDoc.views[0]?.id ?? "";
        if (validView !== currentView) { view = validView; return; }
        if (currentView) endpoint.searchParams.set("view", currentView);
        const response = await fetch(endpoint, { signal: controller.signal });
        if (!response.ok) throw new Error(`Preview unavailable (${response.status})`);
        const doc = pluginPreviewDocumentSchema.parse({ ...await response.json(), html: "" });
        if (controller.signal.aborted) return;
        const chosen = doc.views.some((item) => item.id === currentView) ? currentView : doc.views[0]?.id ?? "";
        if (chosen !== currentView) { view = chosen; return; }
        metadata = doc;
        channel = crypto.randomUUID();
        endpoint.searchParams.delete("format"); endpoint.searchParams.set("channel", channel);
        src = endpoint.pathname + endpoint.search;
        const parentUrl = new URL(location.href);
        parentUrl.searchParams.set("pluginPreview", currentUrl);
        if (view) parentUrl.searchParams.set("previewView", view); else parentUrl.searchParams.delete("previewView");
        history.replaceState(history.state, "", parentUrl);
        const initial = doc.targets.find((target) => target.id === selectedId) ?? doc.targets[0];
        if (initial) select(initial.id);
      } catch (error) {
        if (!controller.signal.aborted) failure = error instanceof Error ? error.message : "Preview unavailable";
      }
    }
    void load();
    return () => controller.abort();
  });
</script>
<div class="flex h-full min-h-0 flex-col" data-testid="plugin-live-preview">
  <div class="flex flex-wrap items-center gap-2 border-b bg-background p-2 text-sm">
    <strong>{metadata?.title ?? "Plugin preview"}</strong>
    {#if metadata?.views.length}
      <button type="button" aria-label="Previous preview page" disabled={metadata.views.findIndex(v => v.id === view) <= 0} onclick={() => { const i = metadata!.views.findIndex(v => v.id === view); const next = metadata?.views[i - 1]; if (next) view = next.id; }}>←</button>
      <select aria-label="Preview page" bind:value={view} class="max-w-64 rounded border bg-background px-2 py-1">
        {#each metadata.views as item}<option value={item.id}>{item.label}</option>{/each}
      </select>
      <button type="button" aria-label="Next preview page" disabled={metadata.views.findIndex(v => v.id === view) >= metadata.views.length - 1} onclick={() => { const i = metadata!.views.findIndex(v => v.id === view); const next = metadata?.views[i + 1]; if (next) view = next.id; }}>→</button>
    {/if}
    <a class="ml-auto underline" href={url} target="_blank" rel="noopener noreferrer">Open full preview</a>
  </div>
  {#if failure}<p role="alert" class="p-4">{failure}</p>
  {:else if src}
    <p class="bg-background px-3 py-1 text-xs text-muted-foreground">Click an image or text to refer to it in the chat.</p>
    <iframe bind:this={iframe} {src} title="Plugin live preview" sandbox="allow-scripts" class="min-h-0 w-full flex-1 border-0 bg-white"></iframe>
  {:else}<p role="status" class="p-4">Loading preview…</p>{/if}
</div>
