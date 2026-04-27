<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Single-select combobox. P6.7 uses it as the page picker in the
   * live-edit overlay (large list, needs filtering, native <select>
   * doesn't filter). Backed by bits-ui Combobox.* primitives — input
   * filters by label substring; keyboard nav comes free.
   *
   * Items are passed in pre-shaped: `{ value, label }`. Filtering is
   * client-side (case-insensitive substring); P6.6 will swap in
   * fuzzy/score-based matching when the command palette also wants it.
   */

  import { Combobox as ComboboxPrimitive } from "bits-ui";
  import { Check, ChevronsUpDown } from "lucide-svelte";
  import { cn } from "$lib/utils.js";

  interface Item {
    value: string;
    label: string;
  }

  interface Props {
    items: Item[];
    value?: string;
    placeholder?: string;
    class?: string;
    onValueChange?: (value: string) => void;
  }
  let {
    items,
    value = $bindable(""),
    placeholder = "Search…",
    class: className,
    onValueChange,
  }: Props = $props();

  let searchValue = $state("");
  const filteredItems = $derived(
    searchValue.trim().length === 0
      ? items
      : items.filter((it) => it.label.toLowerCase().includes(searchValue.toLowerCase())),
  );
  const selectedLabel = $derived(items.find((i) => i.value === value)?.label ?? "");
</script>

<ComboboxPrimitive.Root
  type="single"
  bind:value
  onValueChange={(v) => onValueChange?.(typeof v === "string" ? v : "")}
>
  <div class={cn("relative", className)}>
    <ComboboxPrimitive.Input
      class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 pr-8 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      placeholder={selectedLabel || placeholder}
      oninput={(e) => {
        searchValue = (e.currentTarget as HTMLInputElement).value;
      }}
    />
    <ComboboxPrimitive.Trigger
      class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
      aria-label="Toggle options"
    >
      <ChevronsUpDown class="size-4" />
    </ComboboxPrimitive.Trigger>
  </div>

  <ComboboxPrimitive.Portal>
    <ComboboxPrimitive.Content
      class="z-50 max-h-72 w-[--bits-combobox-anchor-width] overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      sideOffset={4}
    >
      <ComboboxPrimitive.Viewport class="space-y-0.5">
        {#each filteredItems as it (it.value)}
          <ComboboxPrimitive.Item
            value={it.value}
            label={it.label}
            class="relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
          >
            {#snippet children({ selected }: { selected: boolean })}
              {#if selected}<Check class="size-4" />{:else}<span class="size-4"></span>{/if}
              <span>{it.label}</span>
            {/snippet}
          </ComboboxPrimitive.Item>
        {/each}
        {#if filteredItems.length === 0}
          <p class="px-2 py-3 text-center text-xs text-muted-foreground">No matches.</p>
        {/if}
      </ComboboxPrimitive.Viewport>
    </ComboboxPrimitive.Content>
  </ComboboxPrimitive.Portal>
</ComboboxPrimitive.Root>
