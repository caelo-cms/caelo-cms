<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { cn } from "$lib/utils.js";

  type Props = {
    value?: number;
    max?: number;
    class?: string;
  };
  let { value = 0, max = 100, class: className }: Props = $props();
  const pct = $derived(Math.max(0, Math.min(100, (value / Math.max(1, max)) * 100)));
</script>

<div
  role="progressbar"
  aria-valuemin={0}
  aria-valuemax={max}
  aria-valuenow={value}
  class={cn("relative h-2 w-full overflow-hidden rounded-full bg-secondary", className)}
>
  <div
    class="h-full bg-primary transition-all"
    style:width={`${pct}%`}
  ></div>
</div>
