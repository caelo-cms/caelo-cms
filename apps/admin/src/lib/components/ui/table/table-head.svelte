<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "$lib/utils.js";
  type Props = HTMLAttributes<HTMLTableCellElement> & { class?: string };
  let { class: className, children, ...rest }: Props = $props();
</script>

<th
  class={cn(
    "h-10 px-2 text-left align-middle font-medium text-muted-foreground [&:has([role=checkbox])]:pr-0",
    className,
  )}
  {...rest}
>
  {@render children?.()}
</th>
