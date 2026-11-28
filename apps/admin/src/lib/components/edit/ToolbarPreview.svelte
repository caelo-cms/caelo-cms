<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #1760 — one preview of an editor toolbar place (the SDK's
   * `pluginEditorToolbarPreview`): a search result as a result list shows
   * the page, or the card a shared link gets. Drawn from the plugin's
   * values alone, all as text; the plugin cut each text to the width shown
   * here, so nothing is cut again. The card's image is the editor's own
   * copy of a library image (`images`, resolved by the server).
   */

  import type { PluginEditorToolbarPreview } from "@caelo-cms/plugin-sdk";
  import { cn } from "#lib/utils.js";

  let {
    preview,
    images,
  }: {
    preview: PluginEditorToolbarPreview;
    /** Library image id → the editor's URL of it. */
    images: Readonly<Record<string, string>>;
  } = $props();

  const imageUrl = $derived(
    preview.kind === "social-card" && preview.imageAssetId ? images[preview.imageAssetId] : undefined,
  );
</script>

{#if preview.kind === "search-result"}
  <figure class="space-y-1 pt-2" data-testid="toolbar-preview-search" data-device={preview.device}>
    <figcaption class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      Search result · {preview.device === "desktop" ? "desktop" : "phone"}
    </figcaption>
    <div
      class={cn(
        "rounded-md border bg-white p-3 font-[Arial,sans-serif] text-left dark:bg-zinc-950",
        preview.device === "desktop" ? "w-full max-w-[600px]" : "w-[360px] max-w-full",
      )}
    >
      <div class="truncate text-xs text-zinc-700 dark:text-zinc-300">{preview.siteName}</div>
      <div class="truncate text-xs text-zinc-500 dark:text-zinc-400" data-testid="toolbar-preview-url">
        {preview.displayUrl}
      </div>
      <div
        class={cn(
          "mt-1 text-[#1a0dab] dark:text-[#8ab4f8]",
          preview.device === "desktop" ? "text-xl leading-snug" : "text-base leading-snug",
        )}
        data-testid="toolbar-preview-title"
      >
        {preview.title}
      </div>
      {#if preview.description}
        <div class="mt-1 text-sm leading-snug text-zinc-600 dark:text-zinc-300" data-testid="toolbar-preview-description">
          {preview.description}
        </div>
      {:else}
        <div class="mt-1 text-sm italic text-muted-foreground">
          No meta description: the search engine picks text from the page.
        </div>
      {/if}
    </div>
  </figure>
{:else}
  <figure class="space-y-1 pt-2" data-testid="toolbar-preview-social">
    <figcaption class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      Shared link
    </figcaption>
    <div class="w-full max-w-[500px] overflow-hidden rounded-md border bg-card text-left">
      {#if imageUrl}
        <img src={imageUrl} alt="" class="aspect-[1.91/1] w-full object-cover" data-testid="toolbar-preview-image" />
      {:else}
        <div class="flex aspect-[1.91/1] w-full items-center justify-center bg-muted text-xs text-muted-foreground">
          {preview.imageAssetId ? "The share image is missing from the library" : "No share image"}
        </div>
      {/if}
      <div class="space-y-0.5 border-t p-3">
        <div class="truncate text-[11px] uppercase text-muted-foreground">{preview.siteName}</div>
        <div class="text-sm font-semibold leading-snug">{preview.title}</div>
        {#if preview.description}
          <div class="text-xs leading-snug text-muted-foreground">{preview.description}</div>
        {/if}
      </div>
    </div>
  </figure>
{/if}
