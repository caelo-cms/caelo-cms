<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
  import { cn } from "$lib/utils.js";

  type Props = DropdownMenuPrimitive.ContentProps & { class?: string };
  let {
    class: className,
    sideOffset = 4,
    children,
    ref = $bindable(null),
    ...rest
  }: Props = $props();
</script>

<DropdownMenuPrimitive.Portal>
  <DropdownMenuPrimitive.Content
    bind:ref
    {sideOffset}
    class={cn(
      "z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
      className,
    )}
    {...rest}
  >
    {@render children?.()}
  </DropdownMenuPrimitive.Content>
</DropdownMenuPrimitive.Portal>
