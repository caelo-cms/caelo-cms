<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Dialog as DialogPrimitive } from "bits-ui";
  import { cn } from "$lib/utils.js";

  type Props = DialogPrimitive.OverlayProps & { class?: string };
  let { class: className, ref = $bindable(null), ...rest }: Props = $props();
</script>

<DialogPrimitive.Overlay
  bind:ref
  class={cn("fixed inset-0 z-50 bg-black/80", className)}
  {...rest}
/>
