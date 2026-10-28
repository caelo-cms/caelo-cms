<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * The plugin places next to the page address in the live editor's top
   * bar (the SDK's `editorToolbar`). Every place is rendered the same way
   * from data — an icon, an optional short label and count, and a popover
   * with the plugin's summary, its entries and "ask the AI" buttons — so
   * no plugin code runs here, and every value is text (#635). Up to three
   * places show; from four on, two show and the rest share one "+N"
   * popover. A place whose operation failed stays in the bar with a red
   * dot and the reason (#1008: loud, never hidden).
   */

  import { Puzzle } from "lucide-svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Popover, PopoverContent, PopoverTrigger } from "#lib/components/ui/popover/index.js";
  import { PANEL_ICONS } from "#lib/components/plugin-panels/panel-icons.js";
  import { type EditorToolbarSlot, promptText, splitToolbarSlots } from "#lib/plugin-toolbar.js";
  import { cn } from "#lib/utils.js";
  import { askInChat } from "./ask-in-chat.js";

  let {
    slots,
    path,
    pageIds,
    onOpenPage,
  }: {
    slots: readonly EditorToolbarSlot[];
    /** The shown page's path, for `{page}` in prompts. */
    path: string;
    /** Pages the editor can open; an entry's link to any other id is not offered. */
    pageIds: ReadonlySet<string>;
    onOpenPage: (pageId: string) => void;
  } = $props();

  const split = $derived(splitToolbarSlots(slots));
  /** Which popover is open, by slot key ("more" for the +N one). */
  let openKey = $state<string | null>(null);

  const TONE_TEXT = {
    neutral: "",
    attention: "text-amber-700 dark:text-amber-300",
    problem: "text-red-700 dark:text-red-300",
  } as const;
  const TONE_BADGE = {
    neutral: "bg-foreground/80 text-background",
    attention: "bg-amber-500 text-white",
    problem: "bg-red-600 text-white",
  } as const;

  function setOpen(key: string, open: boolean): void {
    openKey = open ? key : openKey === key ? null : openKey;
  }

  function tooltip(slot: EditorToolbarSlot): string {
    return slot.error ?? slot.state?.summary ?? slot.title;
  }

  const moreCount = $derived(
    split.more.reduce((n, s) => n + (s.state?.count ?? 0) + (s.error ? 1 : 0), 0),
  );
</script>

{#snippet slotPanel(slot: EditorToolbarSlot)}
  <div class="space-y-2" data-testid="plugin-toolbar-panel" data-slot={slot.key}>
    <div class="flex items-baseline justify-between gap-3">
      <h2 class="text-sm font-semibold">{slot.title}</h2>
      <span class="font-mono text-[10px] text-muted-foreground">{slot.pluginSlug}</span>
    </div>
    {#if slot.error}
      <p class="text-xs font-medium text-red-700 dark:text-red-300" role="alert">{slot.error}</p>
    {:else if slot.state}
      {#if slot.state.summary}
        <p class="text-xs text-muted-foreground">{slot.state.summary}</p>
      {/if}
      {#if slot.state.items && slot.state.items.length > 0}
        <ul class="-mx-2">
          {#each slot.state.items as entry, i (i)}
            {@const linked = entry.pageId !== undefined && pageIds.has(entry.pageId) && !entry.current}
            {#snippet entryBody()}
              <span class={cn("truncate", entry.current && "font-medium")}>{entry.label}</span>
              {#if entry.detail}
                <span class={cn("ml-auto shrink-0 text-xs text-muted-foreground", entry.tone && TONE_TEXT[entry.tone])}>
                  {entry.detail}
                </span>
              {/if}
            {/snippet}
            <li>
              {#if linked}
                <button
                  type="button"
                  class="flex w-full items-center gap-3 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                  title="Open this page in the editor"
                  data-testid="plugin-toolbar-entry"
                  onclick={() => {
                    openKey = null;
                    onOpenPage(entry.pageId as string);
                  }}
                >
                  {@render entryBody()}
                </button>
              {:else}
                <div class="flex items-center gap-3 px-2 py-1.5 text-sm" data-testid="plugin-toolbar-entry">
                  {@render entryBody()}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
    {#if slot.prompts.length > 0}
      <div class="flex flex-wrap gap-2 pt-1">
        {#each slot.prompts as prompt (prompt.label)}
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="plugin-toolbar-prompt"
            onclick={() => {
              openKey = null;
              askInChat(promptText(prompt.text, path));
            }}
          >
            {prompt.label}
          </Button>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

{#if slots.length > 0}
  <div class="flex items-center gap-0.5" data-testid="plugin-toolbar">
    {#each split.shown as slot (slot.key)}
      {@const Icon = PANEL_ICONS[slot.icon]}
      {@const tone = slot.error ? "problem" : (slot.state?.tone ?? "neutral")}
      <Popover open={openKey === slot.key} onOpenChange={(o) => setOpen(slot.key, o)}>
        <PopoverTrigger
          class="relative inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground motion-reduce:transition-none data-[state=open]:bg-accent data-[state=open]:text-foreground"
          title={tooltip(slot)}
          aria-label={`${slot.title}: ${tooltip(slot)}`}
          data-testid="plugin-toolbar-slot"
          data-slot={slot.key}
          data-tone={tone}
        >
          <Icon class="size-4" />
          {#if slot.state?.label}<span>{slot.state.label}</span>{/if}
          {#if slot.state?.count}
            <span
              class={cn(
                "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] tabular-nums",
                TONE_BADGE[tone],
              )}
            >
              {slot.state.count}
            </span>
          {:else if slot.error}
            <span class="absolute right-1 top-1 size-2 rounded-full bg-red-500" aria-hidden="true"></span>
          {/if}
        </PopoverTrigger>
        <PopoverContent class="p-4">
          {@render slotPanel(slot)}
        </PopoverContent>
      </Popover>
    {/each}
    {#if split.more.length > 0}
      <Popover open={openKey === "more"} onOpenChange={(o) => setOpen("more", o)}>
        <PopoverTrigger
          class="relative inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent"
          title={split.more.map((s) => s.title).join(", ")}
          aria-label={`${split.more.length} more plugins: ${split.more.map((s) => s.title).join(", ")}`}
          data-testid="plugin-toolbar-more"
        >
          <Puzzle class="size-4" />
          <span>+{split.more.length}</span>
          {#if moreCount > 0}
            <span class="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] text-white tabular-nums">
              {moreCount}
            </span>
          {/if}
        </PopoverTrigger>
        <PopoverContent class="max-h-[min(36rem,calc(100vh-6rem))] divide-y overflow-y-auto">
          {#each split.more as slot (slot.key)}
            <div class="p-4">{@render slotPanel(slot)}</div>
          {/each}
        </PopoverContent>
      </Popover>
    {/if}
  </div>
{/if}
