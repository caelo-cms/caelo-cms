<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
  import { cn } from "$lib/utils.js";

  type Props = DropdownMenuPrimitive.SeparatorProps & { class?: string };
  let { class: className, ref = $bindable(null), ...rest }: Props = $props();
</script>

<DropdownMenuPrimitive.Separator
  bind:ref
  class={cn("-mx-1 my-1 h-px bg-muted", className)}
  {...rest}
/>
