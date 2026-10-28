<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Popover as PopoverPrimitive } from "bits-ui";
  import { cn } from "#lib/utils.js";

  type Props = PopoverPrimitive.ContentProps & { class?: string };
  let {
    class: className,
    sideOffset = 6,
    align = "start",
    children,
    ref = $bindable(null),
    ...rest
  }: Props = $props();
</script>

<PopoverPrimitive.Portal>
  <PopoverPrimitive.Content
    bind:ref
    {sideOffset}
    {align}
    class={cn(
      "z-50 w-80 max-w-[calc(100vw-2rem)] rounded-md border bg-popover p-0 text-sm text-popover-foreground shadow-md outline-none",
      className,
    )}
    {...rest}
  >
    {@render children?.()}
  </PopoverPrimitive.Content>
</PopoverPrimitive.Portal>
