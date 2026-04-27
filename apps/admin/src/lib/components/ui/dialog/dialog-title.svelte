<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Dialog as DialogPrimitive } from "bits-ui";
  import { cn } from "$lib/utils.js";

  type Props = DialogPrimitive.TitleProps & { class?: string };
  let { class: className, children, ref = $bindable(null), ...rest }: Props = $props();
</script>

<DialogPrimitive.Title
  bind:ref
  class={cn("text-lg font-semibold leading-none tracking-tight", className)}
  {...rest}
>
  {@render children?.()}
</DialogPrimitive.Title>
