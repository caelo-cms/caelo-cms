<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "$lib/utils.js";
  type Props = HTMLAttributes<HTMLDivElement> & { class?: string };
  let { class: className, children, ...rest }: Props = $props();
</script>

<div class={cn("flex items-center p-6 pt-0", className)} {...rest}>
  {@render children?.()}
</div>
