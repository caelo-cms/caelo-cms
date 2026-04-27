<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "$lib/utils.js";
  type Props = HTMLAttributes<HTMLParagraphElement> & { class?: string };
  let { class: className, children, ...rest }: Props = $props();
</script>

<p class={cn("text-sm text-muted-foreground", className)} {...rest}>
  {@render children?.()}
</p>
