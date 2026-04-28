<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
  import { cn } from "$lib/utils.js";

  type Props = DropdownMenuPrimitive.ItemProps & {
    class?: string;
    inset?: boolean;
  };
  let {
    class: className,
    inset = false,
    children,
    ref = $bindable(null),
    ...rest
  }: Props = $props();
</script>

<DropdownMenuPrimitive.Item
  bind:ref
  class={cn(
    "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors motion-reduce:transition-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
    inset && "pl-8",
    className,
  )}
  {...rest}
>
  {@render children?.()}
</DropdownMenuPrimitive.Item>
