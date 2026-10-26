<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Result card for the retired `edit_module` tool, kept so older chats
   * still render their history: the module id, the result line and a
   * 3-line excerpt of the new HTML. Its successor `update_modules_many`
   * renders through the bulk card plus one inline diff per item.
   */

  import { Pencil } from "lucide-svelte";
  import { Badge } from "#lib/components/ui/badge/index.js";

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
