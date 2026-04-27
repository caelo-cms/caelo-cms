<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import type { HTMLButtonAttributes } from "svelte/elements";
  import { cn } from "$lib/utils.js";
  import { buttonVariants, type ButtonSize, type ButtonVariant } from "./button-variants.js";

  type Props = HTMLButtonAttributes & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    class?: string;
  };
  let {
    variant = "default",
    size = "default",
    class: className,
    children,
    type = "button",
    ...rest
  }: Props = $props();
</script>

<button class={cn(buttonVariants({ variant, size }), className)} {type} {...rest}>
  {@render children?.()}
</button>
