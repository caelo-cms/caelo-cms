<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Tabs as TabsPrimitive } from "bits-ui";
  import { cn } from "$lib/utils.js";

  type Props = TabsPrimitive.ListProps & { class?: string };
  let { class: className, children, ref = $bindable(null), ...rest }: Props = $props();
</script>

<TabsPrimitive.List
  bind:ref
  class={cn(
    "inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground",
    className,
  )}
  {...rest}
>
  {@render children?.()}
</TabsPrimitive.List>
