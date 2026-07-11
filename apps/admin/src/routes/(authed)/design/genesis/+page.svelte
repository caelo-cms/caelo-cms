<!-- SPDX-License-Identifier: MPL-2.0 -->
<script lang="ts">
  /**
   * issue #163 — Genesis draft gallery. Each draft renders in a
   * sandboxed iframe (srcdoc; no scripts, no same-origin) so freeform
   * AI-authored HTML can be previewed without touching admin state.
   */
  import { enhance } from "$app/forms";
  import { page } from "$app/stores";
  import { Button } from "$lib/components/ui/button/index.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const csrf = $derived($page.data.csrfToken ?? "");
</script>

<svelte:head><title>Site Genesis — design drafts</title></svelte:head>

<div class="mx-auto max-w-7xl space-y-6 p-6">
  <div>
    <h1 class="text-2xl font-semibold">Site Genesis — design drafts</h1>
    <p class="text-muted-foreground mt-1 text-sm">
      Each draft is a complete homepage design in its own direction. Pick the one that feels
      right — the site's theme and pages are derived from your choice. You can also tell the AI
      in chat which direction you prefer (or ask for changes to any draft).
    </p>
  </div>

  {#if data.drafts.length === 0}
    <div class="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
      No drafts yet. Ask the AI in chat to design your site — it will propose several design
      directions here.
    </div>
  {:else}
    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {#each data.drafts as draft (draft.id)}
        <div
          class="overflow-hidden rounded-lg border {draft.status === 'selected'
            ? 'ring-primary ring-2'
            : ''}"
        >
          <iframe
            title={draft.direction}
            srcdoc={draft.html}
            sandbox=""
            loading="lazy"
            class="bg-background h-96 w-full border-b"
          ></iframe>
          <div class="flex items-start justify-between gap-4 p-4">
            <div class="min-w-0">
              <div class="font-medium">
                {draft.direction}
                {#if draft.status === "selected"}
                  <span class="text-primary ml-2 text-xs font-semibold uppercase">selected</span>
                {/if}
              </div>
              {#if draft.rationale}
                <p class="text-muted-foreground mt-1 text-sm">{draft.rationale}</p>
              {/if}
            </div>
            {#if draft.status !== "selected"}
              <form method="POST" action="?/select" use:enhance>
                <input type="hidden" name="_csrf" value={csrf} />
                <input type="hidden" name="draftId" value={draft.id} />
                <Button type="submit" size="sm">Select</Button>
              </form>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
