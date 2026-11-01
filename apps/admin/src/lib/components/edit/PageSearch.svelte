<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #1207 — the page search in the live editor's address bar. The shown
   * page's address sits left of it, so the field itself says what it is
   * for ("Search pages…") instead of repeating the page's title. A click
   * or focus opens the list right away with the pages changed last, which
   * are usually the ones opened next; typing searches every page by path
   * and title. Picking a page hands it to `onPick` (the editor asks first
   * when this chat has changes) and clears the field again.
   */

  import { Combobox } from "bits-ui";
  import { tick } from "svelte";
  import { Search } from "lucide-svelte";
  import { cn } from "#lib/utils.js";
  import { pageSearchGroups, type SearchablePage } from "./page-search.js";

  let {
    pages,
    loading = false,
    recent,
    currentPageId,
    onPick,
  }: {
    pages: readonly SearchablePage[];
    /** #1268 — the page list is still streaming in. */
    loading?: boolean;
    /** The pages changed last (newest first), or why they could not be loaded. */
    recent: { readonly pageIds: readonly string[] } | { readonly error: string };
    currentPageId: string;
    onPick: (pageId: string) => void;
  } = $props();

  let open = $state(false);
  let query = $state("");
  let picked = $state("");
  let inputEl = $state<HTMLInputElement | null>(null);

  /**
   * Hands the pick on and empties the field. bits-ui writes the picked
   * item's label into the input after `onValueChange`, so the field is
   * cleared once that has happened, and left so the placeholder shows.
   */
  async function pick(pageId: string): Promise<void> {
    query = "";
    picked = "";
    open = false;
    onPick(pageId);
    await tick();
    if (inputEl) {
      inputEl.value = "";
      inputEl.blur();
    }
  }

  const recentIds = $derived("pageIds" in recent ? recent.pageIds : []);
  const groups = $derived(pageSearchGroups(pages, recentIds, query));
</script>

<Combobox.Root
  type="single"
  bind:open
  bind:value={picked}
  inputValue={query}
  onValueChange={(v) => {
    if (v !== "") void pick(v);
  }}
>
  <div class="relative min-w-0 flex-1">
    <Search
      class="pointer-events-none absolute left-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      aria-hidden="true"
    />
    <Combobox.Input
      bind:ref={inputEl}
      class="h-7 w-full min-w-0 rounded-md bg-transparent pl-7 pr-2 text-sm placeholder:text-muted-foreground focus-visible:bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      placeholder="Search pages…"
      aria-label="Search pages"
      data-testid="page-search-input"
      onfocus={() => (open = true)}
      onclick={() => (open = true)}
      oninput={(e) => {
        query = (e.currentTarget as HTMLInputElement).value;
        open = true;
      }}
    />
  </div>
  <Combobox.Portal>
    <Combobox.Content
      class="z-50 max-h-[min(28rem,calc(100vh-6rem))] w-[max(var(--bits-combobox-anchor-width),24rem)] max-w-[calc(100vw-2rem)] overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      sideOffset={6}
      data-testid="page-search-results"
    >
      {#if "error" in recent && query.trim() === ""}
        <p class="px-2 py-1.5 text-xs text-red-700 dark:text-red-300" role="alert">{recent.error}</p>
      {/if}
      {#each groups as group (group.heading)}
        <Combobox.Group data-testid="page-search-group" data-heading={group.heading}>
          <Combobox.GroupHeading class="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">
            {group.heading}
          </Combobox.GroupHeading>
          {#each group.pages as page (page.id)}
            <Combobox.Item
              value={page.id}
              label={page.currentPath}
              class="flex cursor-default select-none items-baseline gap-3 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
              data-testid="page-search-item"
            >
              <span class={cn("shrink-0 font-mono text-xs", page.id === currentPageId && "font-semibold")}>
                {page.currentPath}
              </span>
              <span class="min-w-0 truncate text-muted-foreground">{page.title}</span>
              {#if page.id === currentPageId}
                <span class="ml-auto shrink-0 text-xs text-muted-foreground">Shown</span>
              {/if}
            </Combobox.Item>
          {/each}
          {#if group.hidden > 0}
            <p class="px-2 py-1.5 text-xs text-muted-foreground">
              {group.hidden} more — type to find them.
            </p>
          {/if}
        </Combobox.Group>
      {:else}
        <p class="px-2 py-3 text-center text-xs text-muted-foreground">
          {loading
            ? "Loading the pages…"
            : query.trim() === ""
              ? "The site has no pages yet."
              : `No page matches “${query.trim()}”.`}
        </p>
      {/each}
    </Combobox.Content>
  </Combobox.Portal>
</Combobox.Root>
