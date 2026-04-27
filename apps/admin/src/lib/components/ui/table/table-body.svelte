<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "$lib/utils.js";
  type Props = HTMLAttributes<HTMLTableSectionElement> & { class?: string };
  let { class: className, children, ...rest }: Props = $props();
</script>

<tbody class={cn("[&_tr:last-child]:border-0", className)} {...rest}>
  {@render children?.()}
</tbody>
