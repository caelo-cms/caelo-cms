<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * v0.2.46 — edit_module result card. The plan calls for "module slug
   * + 3-line excerpt of the new HTML/CSS, with a 'View module' link";
   * the inline-diff card from item #6 will replace this for the diff
   * surface, so this card stays small for now (just the action
   * confirmation, not the full diff).
   */

  import { Pencil } from "lucide-svelte";
  import { Badge } from "$lib/components/ui/badge/index.js";

  interface Props {
    content: string;
    args: Record<string, unknown>;
  }
  let { content, args }: Props = $props();

  const moduleId = $derived(typeof args.moduleId === "string" ? args.moduleId : null);
  const html = $derived(typeof args.html === "string" ? args.html : null);
  const excerpt = $derived(html ? html.split("\n").slice(0, 3).join("\n") : null);
</script>

<div class="rounded-md border bg-card p-3 text-sm" data-testid="tool-card-edit-module">
  <div class="flex items-center gap-2">
    <Badge variant="secondary" class="gap-1">
      <Pencil class="size-3" />
      <span>edit_module</span>
    </Badge>
    {#if moduleId}
      <span class="font-mono text-[10px] text-muted-foreground">{moduleId.slice(0, 8)}…</span>
    {/if}
    <span class="ml-auto text-[10px] text-muted-foreground">staged on chat branch</span>
  </div>
  <p class="mt-1.5 text-xs text-muted-foreground">{content}</p>
  {#if excerpt}
    <pre
      class="mt-2 overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono text-[11px]">{excerpt}{html && html.split("\n").length > 3 ? "\n…" : ""}</pre>
  {/if}
</div>
