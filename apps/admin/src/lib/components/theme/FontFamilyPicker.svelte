<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * v0.11.1 (issue #76) — Google Fonts family picker.
   *
   * Debounced lookup against /design/themes/api/fonts (the SvelteKit
   * +server.ts proxy). The endpoint falls back to a curated 20-family
   * list when GOOGLE_FONTS_API_KEY is unset so the picker stays
   * usable on a fresh dev install.
   *
   * Keeps the operator's freeform input — they can type any font name
   * (including non-Google families like "system-ui") and the dropdown
   * just suggests matches. Picking a row replaces the input value;
   * dismissing the dropdown leaves whatever the operator typed.
   */
  import { Input } from "$lib/components/ui/input/index.js";

  interface FontEntry {
    family: string;
    category?: string;
  }

  interface Props {
    value: string;
    name?: string;
    placeholder?: string;
    onChange: (next: string) => void;
  }
  let { value, name, placeholder, onChange }: Props = $props();

  let open = $state(false);
  let suggestions = $state<FontEntry[]>([]);
  let loading = $state(false);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let fetchToken = 0;

  /**
   * Issue an in-flight fetch that drops stale results — typing
   * `R-o-b-o-t-o` shouldn't let a slow `R` response overwrite a fast
   * `Roboto` response.
   */
  async function fetchSuggestions(query: string): Promise<void> {
    const myToken = ++fetchToken;
    loading = true;
    try {
      const params = new URLSearchParams();
      if (query.trim().length > 0) params.set("q", query.trim());
      const res = await fetch(`/design/themes/api/fonts?${params.toString()}`);
      if (!res.ok) return;
      const body = (await res.json()) as { families: FontEntry[] };
      if (myToken === fetchToken) suggestions = body.families;
    } finally {
      if (myToken === fetchToken) loading = false;
    }
  }

  /** 200ms debounce — typical typing burst beats network round-trip. */
  function scheduleFetch(q: string): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void fetchSuggestions(q);
    }, 200);
  }

  function onInput(e: Event): void {
    const next = (e.target as HTMLInputElement).value;
    onChange(next);
    open = true;
    scheduleFetch(next);
  }

  function onFocus(): void {
    open = true;
    if (suggestions.length === 0) void fetchSuggestions(value);
  }

  function onBlur(): void {
    // Defer so a click on a suggestion lands before the dropdown hides.
    setTimeout(() => (open = false), 150);
  }

  function pick(family: string): void {
    onChange(family);
    open = false;
  }
</script>

<div class="relative">
  <Input
    {name}
    {value}
    {placeholder}
    oninput={onInput}
    onfocus={onFocus}
    onblur={onBlur}
    autocomplete="off"
    class="text-xs"
  />
  {#if open && (suggestions.length > 0 || loading)}
    <div
      class="absolute left-0 right-0 z-30 mt-1 max-h-56 overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md"
      role="listbox"
    >
      {#if loading && suggestions.length === 0}
        <div class="px-2 py-1 text-xs text-muted-foreground">Loading…</div>
      {/if}
      {#each suggestions as f (f.family)}
        <button
          type="button"
          role="option"
          aria-selected={value === f.family}
          class="block w-full rounded px-2 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground"
          style={`font-family: ${JSON.stringify(f.family)}, ${f.category ?? "sans-serif"};`}
          onmousedown={(e) => {
            // mousedown fires before blur — prevents the dropdown from
            // closing before pick() runs.
            e.preventDefault();
            pick(f.family);
          }}
        >
          {f.family}
          {#if f.category}
            <span class="ml-2 text-[10px] text-muted-foreground">{f.category}</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
