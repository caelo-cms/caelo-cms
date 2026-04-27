<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Dialog as DialogPrimitive } from "bits-ui";
  import { X } from "lucide-svelte";
  import DialogOverlay from "./dialog-overlay.svelte";
  import { cn } from "$lib/utils.js";

  type Props = DialogPrimitive.ContentProps & { class?: string };
  let {
    class: className,
    children,
    ref = $bindable(null),
    ...rest
  }: Props = $props();
</script>

<DialogPrimitive.Portal>
  <DialogOverlay />
  <DialogPrimitive.Content
    bind:ref
    class={cn(
      "fixed left-1/2 top-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 border bg-background p-6 shadow-lg sm:rounded-lg",
      className,
    )}
    {...rest}
  >
    {@render children?.()}
    <DialogPrimitive.Close
      class="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
    >
      <X class="size-4" />
      <span class="sr-only">Close</span>
    </DialogPrimitive.Close>
  </DialogPrimitive.Content>
</DialogPrimitive.Portal>
