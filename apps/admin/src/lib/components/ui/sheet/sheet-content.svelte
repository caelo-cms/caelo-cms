<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Dialog as DialogPrimitive } from "bits-ui";
  import { X } from "lucide-svelte";
  import DialogOverlay from "../dialog/dialog-overlay.svelte";
  import { cn } from "$lib/utils.js";
  import { sheetVariants, type SheetSide } from "./sheet-variants.js";

  type Props = DialogPrimitive.ContentProps & { class?: string; side?: SheetSide };
  let {
    class: className,
    side = "right",
    children,
    ref = $bindable(null),
    ...rest
  }: Props = $props();
</script>

<DialogPrimitive.Portal>
  <DialogOverlay />
  <DialogPrimitive.Content bind:ref class={cn(sheetVariants({ side }), className)} {...rest}>
    {@render children?.()}
    <DialogPrimitive.Close
      class="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100"
    >
      <X class="size-4" />
      <span class="sr-only">Close</span>
    </DialogPrimitive.Close>
  </DialogPrimitive.Content>
</DialogPrimitive.Portal>
