<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import type { HTMLTextareaAttributes } from "svelte/elements";
  import { cn } from "$lib/utils.js";

  type Props = HTMLTextareaAttributes & {
    class?: string;
    /** P6.7.4 — bound HTMLTextAreaElement so callers can auto-grow. */
    ref?: HTMLTextAreaElement | null;
  };
  let {
    class: className,
    value = $bindable(),
    ref = $bindable(null),
    ...rest
  }: Props = $props();
</script>

<textarea
  bind:this={ref}
  class={cn(
    "flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
    className,
  )}
  bind:value
  {...rest}
></textarea>
