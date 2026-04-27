<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "$lib/utils.js";
  type Props = HTMLAttributes<HTMLTableRowElement> & { class?: string };
  let { class: className, children, ...rest }: Props = $props();
</script>

<tr
  class={cn(
    "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
    className,
  )}
  {...rest}
>
  {@render children?.()}
</tr>
