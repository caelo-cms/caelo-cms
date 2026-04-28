<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { cn } from "$lib/utils.js";

  /**
   * P6.6a — placeholder block used during slow data loads. Animated
   * pulse on the muted background; respects `prefers-reduced-motion`
   * via Tailwind's `motion-reduce:` variant so the animation pauses
   * for users with the OS preference set.
   */
  type Props = {
    class?: string;
  };
  let { class: className }: Props = $props();
</script>

<div
  aria-hidden="true"
  class={cn(
    "animate-pulse motion-reduce:animate-none rounded-md bg-muted",
    className,
  )}
></div>
