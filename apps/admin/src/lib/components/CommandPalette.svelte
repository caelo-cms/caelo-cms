<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * P6.6b — Cmd+K / Ctrl+K command palette plus vim-style two-key
   * shortcuts (`g p`, `g e`, etc.) for fast navigation. Mounted once
   * by the (authed) layout so every authenticated route gets the
   * keyboard surface.
   *
   * Two distinct keyboard surfaces share this component:
   *  - Cmd/Ctrl+K opens a filterable Dialog of routes + actions.
   *  - "g <key>" / "n <key>" sequences (timed, 1.2s window) jump
   *    directly without opening the palette.
   *
   * Both suppress when focus is inside an editable element so the
   * shortcuts don't intercept normal typing.
   */

  import { goto } from "$app/navigation";
  import {
    FileText,
    LayoutDashboard,
    Layers,
    Layout,
    MessageSquare,
    Plus,
    Rocket,
    Search,
    ShieldCheck,
    Wand2,
  } from "lucide-svelte";
  import { onDestroy, onMount, tick } from "svelte";
  import {
    Dialog,
    DialogContent,
    DialogTitle,
  } from "$lib/components/ui/dialog/index.js";
  import { Input } from "$lib/components/ui/input/index.js";

  interface Item {
    label: string;
    href: string;
    description?: string;
    // biome-ignore lint/suspicious/noExplicitAny: lucide-svelte icon type
    icon: any;
    /** Optional vim sequence ("g p", "n c") that fires this item. */
    shortcut?: string;
  }

  const ITEMS: Item[] = [
    { label: "Dashboard", href: "/", icon: LayoutDashboard, shortcut: "g d" },
    { label: "Live edit", href: "/edit", icon: Wand2, shortcut: "g e" },
    { label: "Pages", href: "/content/pages", icon: FileText, shortcut: "g p" },
    { label: "Modules", href: "/content/modules", icon: Layers, shortcut: "g m" },
    { label: "Templates", href: "/content/templates", icon: Layout, shortcut: "g t" },
    { label: "Chats", href: "/content/chat", icon: MessageSquare, shortcut: "g c" },
    { label: "Deployments", href: "/security/deployments", icon: Rocket, shortcut: "g r" },
    { label: "Security", href: "/security", icon: ShieldCheck, shortcut: "g s" },
    {
      label: "New page",
      href: "/content/pages",
      icon: Plus,
      description: "Open the page-create form",
      shortcut: "n p",
    },
    {
      label: "New chat",
      href: "/content/chat",
      icon: Plus,
      description: "Open the chat list to start one",
      shortcut: "n c",
    },
  ];

  let open = $state(false);
  let query = $state("");
  let inputWrapperEl: HTMLDivElement | null = $state(null);
  let activeIdx = $state(0);

  const filtered = $derived(
    query.trim() === ""
      ? ITEMS
      : ITEMS.filter((it) => {
          const q = query.toLowerCase();
          return (
            it.label.toLowerCase().includes(q) ||
            it.href.toLowerCase().includes(q) ||
            (it.description?.toLowerCase().includes(q) ?? false) ||
            (it.shortcut?.toLowerCase().includes(q) ?? false)
          );
        }),
  );

  // Vim sequence buffer — collected between the leader key ("g" or
  // "n") and the second key, with a timeout that resets if the user
  // doesn't follow up promptly.
  let pendingLeader: string | null = null;
  let leaderTimer: ReturnType<typeof setTimeout> | null = null;
  function clearLeader() {
    pendingLeader = null;
    if (leaderTimer) {
      clearTimeout(leaderTimer);
      leaderTimer = null;
    }
  }

  function isEditableTarget(t: EventTarget | null): boolean {
    if (!(t instanceof HTMLElement)) return false;
    const tag = t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (t.isContentEditable) return true;
    return false;
  }

  async function openPalette() {
    open = true;
    query = "";
    activeIdx = 0;
    await tick();
    // The Input component doesn't expose a `bind:ref` for the
    // underlying <input>; query the DOM by id instead.
    inputWrapperEl?.querySelector("input")?.focus();
  }

  function selectItem(item: Item) {
    open = false;
    void goto(item.href);
  }

  function fireShortcut(seq: string) {
    const item = ITEMS.find((it) => it.shortcut === seq);
    if (item) void goto(item.href);
  }

  function onGlobalKeydown(e: KeyboardEvent) {
    // Cmd/Ctrl+K opens the palette anywhere, including inside inputs.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      void openPalette();
      return;
    }
    if (open) return; // palette open → Dialog handles its own keys
    if (isEditableTarget(e.target)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const k = e.key.toLowerCase();
    if (pendingLeader !== null) {
      // Second key of a sequence.
      const seq = `${pendingLeader} ${k}`;
      clearLeader();
      const matches = ITEMS.some((it) => it.shortcut === seq);
      if (matches) {
        e.preventDefault();
        fireShortcut(seq);
      }
      return;
    }
    if (k === "g" || k === "n") {
      pendingLeader = k;
      leaderTimer = setTimeout(clearLeader, 1_200);
    }
  }

  function onPaletteKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIdx = Math.min(filtered.length - 1, activeIdx + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = Math.max(0, activeIdx - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = filtered[activeIdx];
      if (it) selectItem(it);
    } else if (e.key === "Escape") {
      open = false;
    }
  }

  // Reset selection when the filter narrows past the active row.
  $effect(() => {
    if (activeIdx >= filtered.length) activeIdx = Math.max(0, filtered.length - 1);
  });

  onMount(() => {
    document.addEventListener("keydown", onGlobalKeydown);
  });
  onDestroy(() => {
    if (typeof document !== "undefined") {
      document.removeEventListener("keydown", onGlobalKeydown);
    }
    clearLeader();
  });
</script>

<Dialog bind:open>
  <DialogContent class="max-w-lg gap-0 p-0">
    <DialogTitle class="sr-only">Command palette</DialogTitle>
    <div bind:this={inputWrapperEl} class="flex items-center gap-2 border-b px-3 py-3">
      <Search class="size-4 text-muted-foreground" aria-hidden="true" />
      <Input
        bind:value={query}
        type="text"
        placeholder="Type a command or search..."
        class="border-0 px-0 shadow-none focus-visible:ring-0"
        onkeydown={onPaletteKeydown}
      />
    </div>
    <ul role="listbox" aria-label="Commands" class="max-h-80 overflow-y-auto p-1">
      {#each filtered as item, i (item.href + (item.shortcut ?? ""))}
        <li>
          <button
            type="button"
            role="option"
            aria-selected={i === activeIdx}
            class={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm ${i === activeIdx ? "bg-accent" : "hover:bg-accent"}`}
            onclick={() => selectItem(item)}
            onmouseenter={() => (activeIdx = i)}
          >
            <item.icon class="size-4 text-muted-foreground" aria-hidden="true" />
            <span class="flex-1">
              <span class="font-medium">{item.label}</span>
              {#if item.description}
                <span class="ml-2 text-xs text-muted-foreground">{item.description}</span>
              {/if}
            </span>
            {#if item.shortcut}
              <kbd
                class="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >{item.shortcut}</kbd>
            {/if}
          </button>
        </li>
      {/each}
      {#if filtered.length === 0}
        <li class="px-3 py-6 text-center text-sm text-muted-foreground">No results</li>
      {/if}
    </ul>
    <p class="border-t px-3 py-2 text-xs text-muted-foreground">
      Tip: press <kbd class="rounded border bg-muted px-1 py-0.5 text-[10px]">g</kbd> then a letter
      anywhere in the admin to jump fast.
    </p>
  </DialogContent>
</Dialog>
