<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "$lib/utils.js";
  type Props = HTMLAttributes<HTMLHeadingElement> & { class?: string };
  let { class: className, children, ...rest }: Props = $props();
</script>

<h5 class={cn("mb-1 font-medium leading-none tracking-tight", className)} {...rest}>
  {@render children?.()}
</h5>
