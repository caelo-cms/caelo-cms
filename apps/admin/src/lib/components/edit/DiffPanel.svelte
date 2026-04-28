<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P6.6b — side-by-side iframe diff for the live-edit overlay.
   * Two iframes:
   *   left  — main-branch render (no `?branch=`).
   *   right — chat-branch render with optional `?exclude=...` so
   *           specific pending edits are rolled back.
   *
   * The checkbox list above the iframes lists the module ids the AI
   * has edited on the current chat branch. Unchecking a module adds
   * its id to the `exclude` query param of the right iframe; the
   * preview op's `excludeBranchModules` parameter skips its branch
   * overlay so the user sees what the page would look like if that
   * specific edit didn't ship.
   *
   * The component renders as a fixed full-viewport overlay so it can
   * sit above the live preview iframe while the user reviews. Close
   * via the corner X or by toggling the same button that opened it.
   */

  import { X } from "lucide-svelte";
  import { Button } from "$lib/components/ui/button/index.js";

  interface Props {
    open: boolean;
    locale: string;
    slug: string;
    chatBranchId: string;
    /** Module ids the AI has edited on this branch — populated by the
     *  caller (chat-runner records edited module ids on the session). */
    editedModules: { moduleId: string; label: string }[];
    onclose: () => void;
  }
  let { open, locale, slug, chatBranchId, editedModules, onclose }: Props = $props();

  // Set of module ids the user has UN-checked → those get excluded
  // from the branch overlay on the right iframe.
  let excluded = $state<Set<string>>(new Set());

  function toggleExcluded(id: string): void {
    const next = new Set(excluded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    excluded = next;
  }

  const leftSrc = $derived(`/edit/preview-by-path/${locale}/${slug}`);
  const rightSrc = $derived(() => {
    const params = new URLSearchParams({ branch: chatBranchId });
    if (excluded.size > 0) params.set("exclude", [...excluded].join(","));
    return `/edit/preview-by-path/${locale}/${slug}?${params.toString()}`;
  });
</script>

{#if open}
  <div
    class="fixed inset-0 z-[60] flex flex-col bg-background"
    role="dialog"
    aria-label="Side-by-side diff"
  >
    <header class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <strong class="text-sm">Side-by-side diff</strong>
      <span class="text-xs text-muted-foreground">/{slug} ({locale})</span>
      <Button
        variant="ghost"
        size="icon"
        class="ml-auto"
        aria-label="Close diff"
        onclick={onclose}
      >
        <X class="size-4" />
      </Button>
    </header>

    {#if editedModules.length > 0}
      <div class="flex flex-wrap items-center gap-3 border-b bg-muted/30 px-3 py-2 text-xs">
        <span class="font-medium">Pending edits:</span>
        {#each editedModules as ed (ed.moduleId)}
          <label class="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={!excluded.has(ed.moduleId)}
              onchange={() => toggleExcluded(ed.moduleId)}
              class="h-3.5 w-3.5 rounded border-input"
            />
            <span class={excluded.has(ed.moduleId) ? "text-muted-foreground line-through" : ""}>
              {ed.label}
            </span>
          </label>
        {/each}
        <span class="ml-auto text-muted-foreground">
          Uncheck to preview without that edit on the right.
        </span>
      </div>
    {/if}

    <div class="grid flex-1 grid-cols-2 gap-px overflow-hidden bg-border">
      <div class="flex flex-col bg-background">
        <div class="border-b bg-muted/40 px-2 py-1 text-xs font-medium">Main (current live)</div>
        <iframe
          src={leftSrc}
          title="Main branch preview"
          class="h-full w-full border-0"
          sandbox="allow-scripts allow-same-origin allow-forms"
        ></iframe>
      </div>
      <div class="flex flex-col bg-background">
        <div class="border-b bg-muted/40 px-2 py-1 text-xs font-medium">
          Branch (pending {excluded.size > 0 ? `· ${excluded.size} excluded` : ""})
        </div>
        <iframe
          src={rightSrc()}
          title="Chat branch preview"
          class="h-full w-full border-0"
          sandbox="allow-scripts allow-same-origin allow-forms"
        ></iframe>
      </div>
    </div>
  </div>
{/if}
