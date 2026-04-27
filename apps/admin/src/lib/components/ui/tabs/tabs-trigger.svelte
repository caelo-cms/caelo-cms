<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Tabs as TabsPrimitive } from "bits-ui";
  import { cn } from "$lib/utils.js";

  type Props = TabsPrimitive.TriggerProps & { class?: string };
  let { class: className, children, ref = $bindable(null), ...rest }: Props = $props();
</script>

<TabsPrimitive.Trigger
  bind:ref
  class={cn(
    "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow",
    className,
  )}
  {...rest}
>
  {@render children?.()}
</TabsPrimitive.Trigger>
