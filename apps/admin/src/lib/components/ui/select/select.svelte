<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Native `<select>` wrapper. Keeps form-submission semantics simple
   * (the bits-ui Combobox controlled-state path doesn't compose well
   * with SvelteKit form actions today; revisit in P6.6 once the
   * keyboard/a11y polish wants real virtual scrolling).
   *
   * One source of truth for the select styling — every previous
   * `<select class="flex h-9 w-full rounded-md ...">` in the admin
   * routes pulls from this component.
   */

  import type { HTMLSelectAttributes } from "svelte/elements";
  import { cn } from "$lib/utils.js";

  type Props = HTMLSelectAttributes & { class?: string };
  let { class: className, value = $bindable(), children, ...rest }: Props = $props();
</script>

<select
  class={cn(
    "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
    className,
  )}
  bind:value
  {...rest}
>
  {@render children?.()}
</select>
