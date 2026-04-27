<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "$lib/utils.js";
  import { alertVariants, type AlertVariant } from "./alert-variants.js";

  type Props = HTMLAttributes<HTMLDivElement> & { variant?: AlertVariant; class?: string };
  let { variant = "default", class: className, children, ...rest }: Props = $props();
</script>

<div role="alert" class={cn(alertVariants({ variant }), className)} {...rest}>
  {@render children?.()}
</div>
