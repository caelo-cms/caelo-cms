<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Epic #1644 (#1645) — picks a page for a plugin setting that names one
   * (a results page, a module's home page). Typing searches the site by the
   * start of a page's title and path (`/api/pages/search`); the chosen page
   * shows by its title, its id goes into the setting.
   */

  import { X } from "lucide-svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";

  interface Found {
    id: string;
    title: string;
    currentPath: string;
  }

  let {
    id,
    value,
    label,
    onchange,
  }: { id: string; value: string | null; label?: string; onchange: (value: string | null) => void } =
    $props();

  let query = $state("");
  let found = $state<Found[]>([]);
  let chosen = $state<Found | null>(null);
  let failed = $state<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function search(q: string): Promise<void> {
    if (q.trim() === "") {
      found = [];
      return;
    }
    const res = await fetch(`/api/pages/search?q=${encodeURIComponent(q)}&limit=8`);
    if (!res.ok) {
      failed = `The page search failed (${res.status}).`;
      return;
    }
    failed = null;
    found = ((await res.json()) as { pages: Found[] }).pages;
  }

  function oninput(e: Event): void {
    query = (e.currentTarget as HTMLInputElement).value;
    clearTimeout(timer);
    timer = setTimeout(() => void search(query), 150);
  }

  function pick(p: Found): void {
    chosen = p;
    found = [];
    query = "";
    onchange(p.id);
  }
</script>

<div class="space-y-1">
  {#if value}
    <div class="flex items-center gap-2 text-sm">
      <span>{chosen?.title ?? "A page"}</span>
      <span class="font-mono text-xs text-muted-foreground">{chosen?.currentPath ?? value}</span>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Clear ${label ?? "the page"}`}
        onclick={() => {
          chosen = null;
          onchange(null);
        }}><X class="size-4" /></Button
      >
    </div>
  {/if}
  <Input {id} class="max-w-80" placeholder="Search a page…" value={query} {oninput} autocomplete="off" />
  {#if failed}<p class="text-xs text-destructive">{failed}</p>{/if}
  {#if found.length > 0}
    <ul class="max-w-80 rounded-md border bg-popover text-sm" role="listbox">
      {#each found as p (p.id)}
        <li>
          <button type="button" class="w-full px-2 py-1 text-left hover:bg-accent" onclick={() => pick(p)}>
            {p.title} <span class="font-mono text-xs text-muted-foreground">{p.currentPath}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
