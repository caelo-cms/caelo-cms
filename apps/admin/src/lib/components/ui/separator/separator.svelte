<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { cn } from "$lib/utils.js";

  type Props = {
    orientation?: "horizontal" | "vertical";
    class?: string;
  };
  let { orientation = "horizontal", class: className }: Props = $props();
</script>

<div
  role="separator"
  aria-orientation={orientation}
  class={cn(
    "shrink-0 bg-border",
    orientation === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]",
    className,
  )}
></div>
