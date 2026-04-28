<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P6.6a — empty-state placeholder used by every list route. Pass a
   * lucide icon component, a short title, an action-oriented
   * description, and an optional children snippet for the primary CTA
   * (a link styled via `buttonVariants` or a form Submit button).
   *
   * The component owns spacing + typography only. Icon and CTA are
   * caller-provided so the shape stays neutral across routes that ship
   * different primary actions.
   *
   * `icon` is typed loosely (`any`) — lucide-svelte 5's icon type
   * doesn't satisfy svelte's narrow `Component` interface. Same
   * pattern as `/security/+page.svelte`'s tile rendering.
   */

  import { Card, CardContent } from "$lib/components/ui/card/index.js";
  import { cn } from "$lib/utils.js";

  interface Props {
    // biome-ignore lint/suspicious/noExplicitAny: lucide-svelte icon type
    icon?: any;
    title?: string;
    description: string;
    class?: string;
    children?: import("svelte").Snippet;
  }
  let { icon: Icon, title, description, class: className, children }: Props = $props();
</script>

<Card class={cn("border-dashed", className)}>
  <CardContent class="flex flex-col items-center justify-center gap-3 py-10 text-center">
    {#if Icon}
      <Icon class="size-8 text-muted-foreground" aria-hidden="true" />
    {/if}
    {#if title}
      <p class="text-sm font-medium text-foreground">{title}</p>
    {/if}
    <p class="max-w-md text-sm text-muted-foreground">{description}</p>
    {#if children}
      <div class="mt-2">{@render children?.()}</div>
    {/if}
  </CardContent>
</Card>
