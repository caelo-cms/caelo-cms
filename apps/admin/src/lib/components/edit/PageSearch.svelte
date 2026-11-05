<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #1207 — the page search in the live editor's address bar. The shown
   * page's address sits left of it, so the field itself says what it is
   * for ("Search pages…") instead of repeating the page's title. A click
   * or focus opens the list right away with the pages changed last, which
   * are usually the ones opened next, then the site's first pages; typing
   * searches the whole site on the server (#1269: by the start of the
   * words of a page's title and path). Picking a page hands it to `onPick`
   * (the editor asks first when this chat has changes) and clears the
   * field again.
   */

  import { Combobox } from "bits-ui";
  import { tick } from "svelte";
  import { Search } from "lucide-svelte";
  import { cn } from "#lib/utils.js";
  import { pageSearchGroups, type SearchablePage, searchPagesUntilFound } from "./page-search.js";

  /** How long typing rests before the search asks the server. */
  const SEARCH_DELAY_MS = 150;

  let {
    first,
    recent,
    branchId,
    currentPageId,
    onPick,
  }: {
    /** The site's first pages, null while they stream in (#1268). */
    first: { readonly pages: readonly SearchablePage[]; readonly more: boolean } | null;
    /** The pages changed last (newest first), or why they could not be loaded. */
    recent: { readonly pages: readonly SearchablePage[] } | { readonly error: string };
    /** The chat's branch: the search answers in its view. */
    branchId: string;
    currentPageId: string;
    onPick: (page: SearchablePage) => void;
  } = $props();

  let open = $state(false);
  let query = $state("");
  let picked = $state("");
  let inputEl = $state<HTMLInputElement | null>(null);
  /**
   * The search's answer and its failure, each for the (branch, query) it
   * belongs to: after the operator types on or switches chats, an answer
   * for another query or another chat's view is never shown as this one's.
   */
  let answer = $state<{ key: string; pages: SearchablePage[]; nextCursor: string | null } | null>(
    null,
  );
  let searchError = $state<{ key: string; message: string } | null>(null);
  let loadingMore = $state(false);
  const searchKey = $derived(`${branchId}\u0000${query.trim()}`);
  const current = $derived(answer?.key === searchKey ? answer : null);
  const currentError = $derived(searchError?.key === searchKey ? searchError.message : null);
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // One request per resting query, in the chat's view: both are read here,
  // so a newer query or a chat switch aborts the older request.
  $effect(() => {
    const q = query.trim();
    const branch = branchId;
    if (q === "") return;
    const key = `${branch}\u0000${q}`;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchPagesUntilFound(q, branch, controller.signal)
        .then((r) => {
          answer = { key, ...r };
          searchError = null;
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return;
          answer = null;
          searchError = { key, message: message(e) };
        });
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });

  /** The next matches of the shown answer, appended (a call stops at its candidate cap). */
  async function showMore(): Promise<void> {
    const shown = current;
    if (!shown?.nextCursor || loadingMore) return;
    const [branch, q] = shown.key.split("\u0000") as [string, string];
    loadingMore = true;
    try {
      const r = await searchPagesUntilFound(q, branch, new AbortController().signal, {
        cursor: shown.nextCursor,
      });
      if (answer?.key === shown.key) {
        answer = { key: shown.key, pages: [...shown.pages, ...r.pages], nextCursor: r.nextCursor };
      }
    } catch (e) {
      searchError = { key: shown.key, message: message(e) };
    } finally {
      loadingMore = false;
    }
  }

  /**
   * Hands the pick on and empties the field. bits-ui writes the picked
   * item's label into the input after `onValueChange`, so the field is
   * cleared once that has happened, and left so the placeholder shows.
   */
  async function pick(pageId: string): Promise<void> {
    const page = groups.flatMap((g) => g.pages).find((p) => p.id === pageId);
    query = "";
    picked = "";
    open = false;
    if (page) onPick(page);
    await tick();
    if (inputEl) {
      inputEl.value = "";
      inputEl.blur();
    }
  }

  const searching = $derived(query.trim() !== "" && current === null && currentError === null);
  const groups = $derived(
    pageSearchGroups(
      {
        recent: "pages" in recent ? recent.pages : [],
        first: first ?? { pages: [], more: false },
        results: current ? { pages: current.pages, more: current.nextCursor !== null } : null,
      },
      query,
    ),
  );
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
      {#if currentError}
        <p class="px-2 py-1.5 text-xs text-red-700 dark:text-red-300" role="alert" data-testid="page-search-error">
          {currentError}
        </p>
      {/if}
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
          {#if group.more && query.trim() === ""}
            <p class="px-2 py-1.5 text-xs text-muted-foreground" data-testid="page-search-more">
              More pages — type to find them.
            </p>
          {:else if group.more}
            <!-- Kept in the list on press: mousedown would blur the field and close it. -->
            <button
              type="button"
              class="w-full rounded-sm px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent"
              data-testid="page-search-more"
              disabled={loadingMore}
              onmousedown={(e) => e.preventDefault()}
              onclick={() => void showMore()}
            >
              {loadingMore ? "Looking for more…" : "More pages may match — show more"}
            </button>
          {/if}
        </Combobox.Group>
      {:else}
        {#if !currentError}
          <p class="px-2 py-3 text-center text-xs text-muted-foreground">
            {query.trim() === ""
              ? first === null
                ? "Loading the pages…"
                : "The site has no pages yet."
              : searching
                ? "Searching…"
                : `No page matches “${query.trim()}”.`}
          </p>
        {/if}
      {/each}
    </Combobox.Content>
  </Combobox.Portal>
</Combobox.Root>
