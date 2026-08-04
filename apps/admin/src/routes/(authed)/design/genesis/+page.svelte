<!-- SPDX-License-Identifier: MPL-2.0 -->
<script lang="ts">
  /**
   * issue #163 / #375 — design-draft gallery. Site-scope Genesis
   * drafts render in srcdoc iframes (sandbox=""); growth-time variant
   * sets render via the /design/drafts/[id]/preview route (theme-shell
   * composition server-side, sandbox="allow-same-origin" — no scripts;
   * see +page.server.ts for the full stance).
   */
  import { enhance } from "$app/forms";
  import { page } from "$app/stores";
  import { Button } from "$lib/components/ui/button/index.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const csrf = $derived($page.data.csrfToken ?? "");
</script>

{#snippet draftMeta(draft: { direction: string; rationale: string; status: string; id: string })}
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
{/snippet}

<svelte:head><title>Design drafts</title></svelte:head>

<div class="mx-auto max-w-7xl space-y-10 p-6">
  <div>
    <h1 class="text-2xl font-semibold">Design drafts</h1>
    <p class="text-muted-foreground mt-1 text-sm">
      Compare design directions side by side and pick the one that feels right. You can also tell
      the AI in chat which one you prefer, or ask for changes to any draft.
    </p>
  </div>

  {#if data.variantSets.length > 0}
    <div class="space-y-8">
      {#each data.variantSets as set (set.variantSetId)}
        <section class="space-y-3">
          <h2 class="text-lg font-medium">
            {set.scope === "module" ? "Module variants" : "Page variants"}
            <span class="text-muted-foreground ml-2 text-xs font-normal"
              >{set.drafts.length} option{set.drafts.length === 1 ? "" : "s"} — previewed in your
              site's current theme</span
            >
          </h2>
          <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {#each set.drafts as draft (draft.id)}
              <div
                class="overflow-hidden rounded-lg border {draft.status === 'selected'
                  ? 'ring-primary ring-2'
                  : ''}"
              >
                <iframe
                  title={draft.direction}
                  src={`/design/drafts/${draft.id}/preview`}
                  sandbox="allow-same-origin"
                  loading="lazy"
                  class="bg-background h-96 w-full border-b"
                ></iframe>
                {@render draftMeta(draft)}
              </div>
            {/each}
          </div>
        </section>
      {/each}
    </div>
  {/if}

  <section class="space-y-3">
    {#if data.variantSets.length > 0}
      <h2 class="text-lg font-medium">Site designs</h2>
    {/if}
    {#if data.siteDrafts.length === 0 && data.variantSets.length === 0}
      <div class="text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
        No drafts yet. Ask the AI in chat to design your site — or to propose design variants for
        any page or section — and the options will appear here.
      </div>
    {:else if data.siteDrafts.length > 0}
      <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {#each data.siteDrafts as draft (draft.id)}
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
            {@render draftMeta(draft)}
          </div>
        {/each}
      </div>
    {/if}
  </section>
</div>
