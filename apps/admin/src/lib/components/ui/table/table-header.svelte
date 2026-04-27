<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "$lib/utils.js";
  type Props = HTMLAttributes<HTMLTableSectionElement> & { class?: string };
  let { class: className, children, ...rest }: Props = $props();
</script>

<thead class={cn("[&_tr]:border-b", className)} {...rest}>
  {@render children?.()}
</thead>
