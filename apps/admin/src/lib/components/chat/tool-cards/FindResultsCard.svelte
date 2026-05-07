<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * v0.2.46 — find_media / find_redirects result card. The find tools
   * return a numbered list of matches. Render as a compact list with
   * a header summary instead of raw text.
   */

  import { Search } from "lucide-svelte";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import StreamingMarkdown from "../StreamingMarkdown.svelte";

  interface Props {
    name: string;
    content: string;
  }
  let { name, content }: Props = $props();

  // Try to detect a leading "Found N <thing>" header; show it as a
  // badge. Body becomes the markdown-rendered list.
  const headerMatch = $derived(content.match(/^(Found\s+\d+[^\n.]*)\.?/));
</script>

<div class="rounded-md border bg-card p-3 text-sm" data-testid="tool-card-find">
  <div class="flex items-center gap-2">
    <Badge variant="secondary" class="gap-1">
      <Search class="size-3" />
      <span>{name}</span>
    </Badge>
    {#if headerMatch?.[1]}
      <span class="text-xs text-muted-foreground">{headerMatch[1]}</span>
    {/if}
  </div>
  <StreamingMarkdown text={content} class="mt-1.5 text-xs" />
</div>
