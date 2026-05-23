<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * v0.12.3 — "where it's placed" list. Used by /content/library/[id]
   * to show the operator which pages will be affected by an edit
   * (synced → propagates; unsynced → page-local).
   */
  import { Badge } from "$lib/components/ui/badge/index.js";

  interface Placement {
    pageId: string;
    pageSlug: string;
    pageTitle: string;
    blockName: string;
    position: number;
    syncMode: "synced" | "unsynced";
  }

  let { placements }: { placements: Placement[] } = $props();
</script>

{#if placements.length === 0}
  <p class="text-sm text-muted-foreground">
    No placements reference this instance. Safe to delete from this view, or bind to a placement
    via the page editor.
  </p>
{:else}
  <ul class="space-y-2 text-sm">
    {#each placements as p (`${p.pageId}#${p.blockName}#${p.position}`)}
      <li class="flex items-center gap-2">
        <a class="underline-offset-4 hover:underline" href={`/edit/${p.pageId}`}>
          <span class="font-medium">{p.pageTitle}</span>
          <span class="text-muted-foreground">/{p.pageSlug}</span>
        </a>
        <span class="text-muted-foreground">·</span>
        <span class="font-mono text-xs text-muted-foreground">
          {p.blockName}#{p.position}
        </span>
        {#if p.syncMode === "synced"}
          <Badge variant="default">synced</Badge>
        {:else}
          <Badge variant="outline">unsynced</Badge>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
