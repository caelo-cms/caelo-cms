<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "$lib/utils.js";
  import { badgeVariants, type BadgeVariant } from "./badge-variants.js";

  type Props = HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant; class?: string };
  let { variant = "default", class: className, children, ...rest }: Props = $props();
</script>

<span class={cn(badgeVariants({ variant }), className)} {...rest}>
  {@render children?.()}
</span>
