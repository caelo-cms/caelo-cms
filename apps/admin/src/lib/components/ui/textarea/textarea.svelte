<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import type { HTMLTextareaAttributes } from "svelte/elements";
  import { cn } from "$lib/utils.js";

  type Props = HTMLTextareaAttributes & { class?: string };
  let { class: className, value = $bindable(), ...rest }: Props = $props();
</script>

<textarea
  class={cn(
    "flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
    className,
  )}
  bind:value
  {...rest}
></textarea>
