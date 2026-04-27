<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "$lib/utils.js";
  type Props = HTMLAttributes<HTMLTableCellElement> & { class?: string };
  let { class: className, children, ...rest }: Props = $props();
</script>

<td class={cn("p-2 align-middle [&:has([role=checkbox])]:pr-0", className)} {...rest}>
  {@render children?.()}
</td>
