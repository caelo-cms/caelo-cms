<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import type { HTMLLabelAttributes } from "svelte/elements";
  import { cn } from "$lib/utils.js";

  type Props = HTMLLabelAttributes & { class?: string };
  let { class: className, children, ...rest }: Props = $props();
</script>

<label
  class={cn(
    "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
    className,
  )}
  {...rest}
>
  {@render children?.()}
</label>
