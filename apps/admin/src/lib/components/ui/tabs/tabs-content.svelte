<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Tabs as TabsPrimitive } from "bits-ui";
  import { cn } from "$lib/utils.js";

  type Props = TabsPrimitive.ContentProps & { class?: string };
  let { class: className, children, ref = $bindable(null), ...rest }: Props = $props();
</script>

<TabsPrimitive.Content
  bind:ref
  class={cn(
    "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    className,
  )}
  {...rest}
>
  {@render children?.()}
</TabsPrimitive.Content>
