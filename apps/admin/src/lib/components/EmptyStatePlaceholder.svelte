<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Minimal empty-state placeholder. Lists call this when their data
   * source is empty so P6.6's polished version (illustrations + primary
   * CTAs) has somewhere to plug in without rewriting every list route.
   */

  import { Card, CardContent } from "$lib/components/ui/card/index.js";
  import { cn } from "$lib/utils.js";

  interface Props {
    title?: string;
    description: string;
    class?: string;
    children?: import("svelte").Snippet;
  }
  let { title, description, class: className, children }: Props = $props();
</script>

<Card class={cn("border-dashed", className)}>
  <CardContent class="flex flex-col items-center justify-center gap-2 py-10 text-center">
    {#if title}
      <p class="text-sm font-medium text-foreground">{title}</p>
    {/if}
    <p class="text-sm text-muted-foreground">{description}</p>
    {#if children}
      <div class="mt-2">{@render children?.()}</div>
    {/if}
  </CardContent>
</Card>
