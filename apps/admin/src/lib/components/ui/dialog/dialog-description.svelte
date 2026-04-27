<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Dialog as DialogPrimitive } from "bits-ui";
  import { cn } from "$lib/utils.js";

  type Props = DialogPrimitive.DescriptionProps & { class?: string };
  let { class: className, children, ref = $bindable(null), ...rest }: Props = $props();
</script>

<DialogPrimitive.Description
  bind:ref
  class={cn("text-sm text-muted-foreground", className)}
  {...rest}
>
  {@render children?.()}
</DialogPrimitive.Description>
